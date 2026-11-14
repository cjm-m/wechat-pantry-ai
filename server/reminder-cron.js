#!/usr/bin/env node
// 订阅消息下发器：跑在自己的服务器上，由 cron 每 5 分钟拉起一次。
//
// 一个进程里跑两条独立链路：
//   1. 临期提醒 —— 定时扫库聚合，reminder_due 取「到点且今天没发过」的用户，每人每天最多一条；
//   2. 点菜提醒 —— 事件驱动，dish_notify 把「点菜/接单」写进 reminder_job 队列，这里逐条发。
// 两条链路互不拖累：一边读失败只记日志，另一边照发。
//
// 为什么单独放在服务器上：subscribeMessage.send 必须持 appid + secret 换 access_token，
// 这段代码不能进小程序包（会被反编译）。而托管云服务没有定时任务能力，
// 所以需要一个外部执行器。
//
// ============ 部署步骤 ============
// 1. 装 Node 18+（更早版本也能跑，本文件不依赖 fetch，只用 https）。
// 2. 把本文件拷到服务器，例如 /opt/reminder/reminder-cron.js，chmod 644。
// 3. 用环境变量提供六个值（建议写进 systemd 的 Environment= 或 crontab 上方的赋值，
//    不要写在文件里，避免随代码泄露）：
//
//      WB_ENDPOINT=https://your-domain.example.com
//      WB_ANON_KEY=<utils/cloud.js 里的 publishableKey，本来就是公开的>
//      REMINDER_TOKEN=<见下方说明>
//      WX_APPID=<小程序 appid>
//      WX_SECRET=<小程序 secret，在公众平台「开发 → 开发设置」里生成>
//      WX_TEMPLATE_EXPIRE=<临期提醒模板 ID>
//      WX_TEMPLATE_DISH=<点菜提醒模板 ID>   # 选填：不填则点菜只发站内消息，不发微信
//      WX_MINIPROGRAM_STATE=formal        # 联调时先改成 developer 或 trial
//
// 4. crontab -e 加一行（每 5 分钟，脚本自己判断是不是到了某个用户的提醒时间）：
//
//      */5 * * * * cd /opt/reminder && set -a && . ./reminder.env && set +a && /usr/bin/node reminder-cron.js >> /var/log/reminder.log 2>&1
//
//    必须带 `set -a && . ./reminder.env && set +a`：cron 环境里只有 SHELL/PATH/HOME，
//    不显式 source 会直接以「缺少环境变量」退出。
//
// 5. 先手动空跑验证：DRY_RUN=1 node reminder-cron.js
//
// ============ 安全模型 ============
// 云数据库那边不放 service_role（也拿不到），改用一个共享令牌：reminder_due(p_token)
// 和 reminder_confirm(p_token, p_user_id) 都是 SECURITY DEFINER，内部比对令牌的 sha256。
// 所以拿着 anon key 直接调这两个函数是无效的，必须同时知道令牌。
// 令牌换掉的方法：用新令牌的 sha256 重新 CREATE OR REPLACE 这两个函数（更换时两处都要改）。

const https = require('https');
const { URL } = require('url');

const ENDPOINT = (process.env.WB_ENDPOINT || '').replace(/\/+$/, '');
const ANON_KEY = process.env.WB_ANON_KEY || '';
const TOKEN = process.env.REMINDER_TOKEN || '';
const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
// 模板 ID 必须由环境变量提供：它出现在每条推送里、不算机密，但也不该硬编码进开源仓库
// （公开的模板 ID 会让别人往你的模板里发消息）。未配置时整条链路跳过并记日志。
const TEMPLATE_ID = process.env.WX_TEMPLATE_EXPIRE || '';
const MP_STATE = process.env.WX_MINIPROGRAM_STATE || 'formal';
const DRY_RUN = process.env.DRY_RUN === '1';

// 点开推送后落到哪一页。订阅消息的 page 字段不带前导斜杠。
const LANDING_PAGE = 'pages/fridge/fridge';

// 「保质期到期提醒」模板（编号 7153）的字段契约，逐字来自模板详情页。
// 换模板必须同步改这里，否则微信返回 47003，而且不告诉你是哪个字段错了。
//   thing1  物品名称  ≤20 字符
//   number5 剩余天数  纯数字
//   date2   到期日期  yyyy-MM-dd
//   thing4  存放位置  ≤20 字符
//   thing8  温馨提醒  ≤20 字符
const THING_MAX = 20;

function clip(value, max) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// 物品名称要塞进 20 个字。策略：全列得下就全列，列不下就「第一件 等 N 样」。
// 这一步必须在客户端做，SQL 里算不出字符数——中文在 PG 里是 length()，在微信那边也是按字符算，
// 但把「等 N 样」的拼装逻辑散到 SQL 里会很难改。
function nameText(row) {
    const count = Number(row.item_count) || 0;
    const names = String(row.item_names || '').split('、').filter((item) => item !== '');
    if (count <= 0 || names.length === 0) return '食材';
    if (count === 1) return clip(names[0], THING_MAX);

    const all = names.slice(0, count).join('、');
    if (all.length <= THING_MAX) return all;

    const suffix = ' 等 ' + count + ' 样';
    if (names[1] && (names[0] + '、' + names[1]).length + suffix.length <= THING_MAX) {
        return clip(names[0] + '、' + names[1] + suffix, THING_MAX);
    }
    return clip(names[0] + suffix, THING_MAX);
}

// 温馨提醒是唯一能自由写文案的字段，用来表达「剩余天数: 0」说不清的语义。
function warmText(row) {
    const days = Number(row.earliest_days);
    if (!Number.isFinite(days)) return '记得及时吃掉';
    if (days < 0) return '有食材已过期，尽快处理';
    if (days === 0) return '今天到期，记得吃掉';
    if (days === 1) return '明天到期，记得安排';
    return '还有 ' + days + ' 天，记得安排';
}

// number 类型只收数字，负数在通知里读起来很怪（「剩余天数 -1」），
// 所以超期的情况一律钳到 0，语义交给温馨提醒表达。
function daysText(row) {
    const days = Number(row.earliest_days);
    if (!Number.isFinite(days)) return '0';
    return String(Math.max(Math.round(days), 0));
}

function dateText(value) {
    const text = String(value === null || value === undefined ? '' : value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function buildExpireData(row) {
    return {
        thing1: { value: nameText(row) },
        number5: { value: daysText(row) },
        date2: { value: dateText(row.earliest_date) },
        thing4: { value: clip(row.earliest_storage || '冷藏', THING_MAX) },
        thing8: { value: warmText(row) },
    };
}

// ---------- 点菜提醒（事件驱动，与上面的定时聚合是两条独立链路）----------
//
// 数据来源不是扫库，而是 dish_notify 在「点菜成功 / 接单成功」时写进 reminder_job 的队列。
// 队列里的 fire_at 已经处理过静默时段（23:00–08:00 顺延到次日 08:00），所以这里只管发。
//
// 模板未配置时不要硬发：字段对不上会 47003，而且报错不说是哪个字段，比不发更难查。
// 留空时把队列标成 skipped，站内消息不受影响（它由数据库函数直接写，不经过这里）。
const DISH_TEMPLATE_ID = process.env.WX_TEMPLATE_DISH || '';

// 「家庭点餐下单完成通知」模板（编号 69187）的字段契约，逐字来自模板详情页。
// 注意 key 不是顺序编号：菜品名称=thing5 / 餐食类型=thing8 / 下单用户=thing4 / 备注=thing7。
// 这个模板没有「状态」字段，所以「待接单 / 已接单」要并进备注，否则两条消息长得一模一样、分不出来。
const DISH_FIELD_KEYS = ['thing5', 'thing8', 'thing4', 'thing7'];
const DISH_FIELD_LIMITS = [20, 20, 20, 20];

function buildDishData(row) {
    const p = row.payload || {};

    // 备注承载三样：状态（模板无此字段）、用餐日期、用户自己写的备注。
    // 用中点连接而不是「 · 」，是为了在 20 字上限里多塞一个字段。
    const parts = [p.status || '点菜'];
    if (p.date) parts.push(p.date);
    if (p.note) parts.push(p.note);

    const texts = [
        p.dish || row.title || '',          // 菜品名称
        p.slot || '未指定',                  // 餐食类型（早餐/午餐/晚餐/都行）
        p.who || 'TA',                       // 下单用户
        parts.join('·'),                     // 备注
    ];

    const data = {};
    DISH_FIELD_KEYS.forEach((key, index) => {
        const value = clip(texts[index] || '', DISH_FIELD_LIMITS[index]);
        // 空值不能直接给 ''：thing 字段留空会被微信判成不合法，宁可写占位。
        data[key] = { value: value === '' ? '未指定' : value };
    });
    return data;
}

// 日志统一按北京时间打，不跟随宿主机时区：
// 服务器是 UTC，cron 每 5 分钟拉起，日志里如果混着 UTC 时间会对不上用户的 remind_at。
// 中国不实行夏令时，固定 +8 即可，不引 ICU。
function log(message) {
    const beijing = new Date(Date.now() + 8 * 3600 * 1000);
    const stamp = beijing.toISOString().replace('T', ' ').slice(0, 19);
    console.log('[' + stamp + ' +08] ' + message);
}

function postJson(urlString, body, headers) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(urlString);
        } catch (error) {
            reject(new Error('地址不合法: ' + urlString));
            return;
        }
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const request = https.request(
            {
                hostname: target.hostname,
                port: target.port || 443,
                path: target.pathname + (target.search || ''),
                method: 'POST',
                headers: Object.assign(
                    {
                        'Content-Type': 'application/json',
                        'Content-Length': payload.length,
                    },
                    headers
                ),
                timeout: 20000,
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') });
                });
            }
        );
        request.on('timeout', () => request.destroy(new Error('请求超时')));
        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

// 走 PostgREST 接口调 RPC。用 publishableKey 即可：
// 这两个函数是 SECURITY DEFINER，权限判断在函数内部用令牌完成，不依赖调用者身份。
//
// 两个容易踩错的地方：
//   1. 路径是 `/.cloud/database/rest/rpc/<fn>`，不是 Supabase 那套 `/rest/v1/rpc/`。
//      后者会打到前端站点上，返回 404 的「链接已失效」HTML 页，看起来像域名错了。
//   2. 鉴权头是 `x-wb-webapp-access-key`（SDK 里的 PUBLISHABLE_KEY_HEADER），不是 `apikey`。
//      用错头会返回 401 invalid_client，容易被误判成 key 过期。
// 不需要 Authorization 头：这个 key 本身就是匿名身份。
async function callRpc(fn, body) {
    const response = await postJson(ENDPOINT + '/.cloud/database/rest/rpc/' + fn, body, {
        'x-wb-webapp-access-key': ANON_KEY,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error('调用 ' + fn + ' 失败 HTTP ' + response.status + ' ' + clip(response.text, 300));
    }
    if (response.text.trim() === '') return null;
    return JSON.parse(response.text);
}

// access_token 用 stable_token 而不是普通 token：
// 普通接口每次调用都会让上一个 token 失效，多实例或多脚本并存时会互相顶掉。
async function getAccessToken() {
    const response = await postJson(
        'https://api.weixin.qq.com/cgi-bin/stable_token',
        { grant_type: 'client_credential', appid: APPID, secret: SECRET, force_refresh: false },
        {}
    );
    const data = JSON.parse(response.text);
    if (!data.access_token) {
        throw new Error('拿不到 access_token：' + (data.errmsg || response.text));
    }
    return data.access_token;
}

async function sendOne(accessToken, row) {
    const body = {
        touser: row.openid,
        template_id: TEMPLATE_ID,
        page: LANDING_PAGE,
        data: buildExpireData(row),
        miniprogram_state: MP_STATE,
        lang: 'zh_CN',
    };

    if (DRY_RUN) {
        log('DRY_RUN 不发送，请求体：' + JSON.stringify(body));
        // dryRun 标记必须带出去：否则 main 会按 errcode 0 回写 last_sent_on，
        // 把当天记成「已发过」，真到点反而一条都发不出去——空跑反而破坏了当天的提醒。
        return { errcode: 0, errmsg: 'dry-run', dryRun: true };
    }

    const response = await postJson(
        'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + accessToken,
        body,
        {}
    );

    let data = {};
    try {
        data = JSON.parse(response.text);
    } catch (error) {
        return { errcode: -1, errmsg: '微信返回的不是 JSON: ' + clip(response.text, 200) };
    }
    return data;
}

// 43101 = 用户拒收或额度已用尽。重试一整天也不会有变化，所以同样记为"今天已处理"，
// 否则会每个小时白跑一次。
function shouldConfirm(errcode) {
    return errcode === 0 || errcode === 43101;
}

async function main() {
    const missing = [
        ['WB_ENDPOINT', ENDPOINT],
        ['WB_ANON_KEY', ANON_KEY],
        ['REMINDER_TOKEN', TOKEN],
        ['WX_APPID', APPID],
        ['WX_SECRET', SECRET],
    ]
        .filter((pair) => !pair[1])
        .map((pair) => pair[0]);

    if (missing.length > 0) {
        log('缺少环境变量：' + missing.join(', '));
        process.exit(1);
    }

    let rows;
    try {
        rows = await callRpc('reminder_due', { p_token: TOKEN });
    } catch (error) {
        log('读取待发列表失败：' + error.message);
        process.exit(1);
    }

    const list = Array.isArray(rows) ? rows : [];
    const jobs = await readJobs();

    if (list.length === 0 && jobs.length === 0) {
        log('没有待发提醒');
        return;
    }

    // 模板没配就把队列标掉：留成 pending 会一直累积，而且每 5 分钟白跑一次。
    let pendingJobs = [];
    if (jobs.length > 0 && !DISH_TEMPLATE_ID) {
        await skipJobs(jobs, 'NO_TEMPLATE');
        log('点菜提醒模板未配置，跳过 ' + jobs.length + ' 条（站内消息已送达）');
    } else {
        pendingJobs = jobs;
    }

    // 临期模板没配时整条链路跳过：硬发会 47003，且报错不说是哪个字段，比不发更难查。
    const pendingExpire = TEMPLATE_ID ? list : [];
    if (list.length > 0 && !TEMPLATE_ID) {
        log('临期提醒模板未配置（WX_TEMPLATE_EXPIRE），跳过 ' + list.length + ' 条（站内消息不受影响）');
    }

    if (pendingExpire.length === 0 && pendingJobs.length === 0) return;

    if (pendingExpire.length > 0) log('临期待发 ' + pendingExpire.length + ' 条');
    if (pendingJobs.length > 0) log('点菜待发 ' + pendingJobs.length + ' 条');

    let accessToken = '';
    try {
        accessToken = await getAccessToken();
    } catch (error) {
        log('获取 access_token 失败：' + error.message);
        process.exit(1);
    }

    for (const row of pendingExpire) {
        const result = await sendOne(accessToken, row);
        const errcode = Number(result.errcode) || 0;

        if (result.dryRun === true) {
            log('空跑，不回写 user=' + row.user_id);
        } else if (errcode === 0) {
            log('已发送 user=' + row.user_id + ' 食材数=' + row.item_count);
        } else if (errcode === 43101) {
            log('用户没有额度或已拒收 user=' + row.user_id + '（站内消息仍会显示）');
        } else {
            log('发送失败 user=' + row.user_id + ' errcode=' + errcode + ' ' + (result.errmsg || ''));
        }

        // 空跑绝不回写：写下去等于「今天已经发过了」，会把当天真正的提醒吃掉。
        if (result.dryRun === true) continue;

        if (shouldConfirm(errcode)) {
            try {
                await callRpc('reminder_confirm', { p_token: TOKEN, p_user_id: row.user_id });
            } catch (error) {
                log('回写发送状态失败 user=' + row.user_id + '：' + error.message);
            }
        }
    }

    for (const job of pendingJobs) {
        await sendJob(accessToken, job);
    }
}

async function readJobs() {
    try {
        const raw = await callRpc('reminder_jobs', { p_token: TOKEN });
        return Array.isArray(raw) ? raw : [];
    } catch (error) {
        // 队列读不到不该拖垮临期提醒，两边是独立链路。
        log('读取点菜提醒失败：' + error.message);
        return [];
    }
}

async function markJob(id, status, errCode) {
    try {
        await callRpc('reminder_job_done', {
            p_token: TOKEN,
            p_id: id,
            p_status: status,
            p_err: errCode || '',
        });
    } catch (error) {
        log('回写任务 ' + id + ' 失败：' + error.message);
    }
}

async function skipJobs(jobs, reason) {
    for (const job of jobs) {
        await markJob(job.id, 'skipped', reason);
    }
}

// 一条点菜提醒。与临期不同，这里每条都要单独回写：失败的不能静默吞掉，
// 否则队列会一直重试，而用户永远收不到。
async function sendJob(accessToken, job) {
    if (job.ready !== true) {
        // 用户关掉了提醒或没有 openid：微信这条路本来就不通，标掉即可，站内消息已经送达。
        await markJob(job.id, 'skipped', 'NO_OPENID');
        return;
    }

    const body = {
        touser: job.openid,
        template_id: DISH_TEMPLATE_ID,
        page: job.page || 'pages/dishes/dishes',
        data: buildDishData(job),
        miniprogram_state: MP_STATE,
        lang: 'zh_CN',
    };

    if (DRY_RUN) {
        log('DRY_RUN 点菜不发送，请求体：' + JSON.stringify(body));
        return;
    }

    let result = {};
    try {
        const response = await postJson(
            'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + accessToken,
            body,
            {}
        );
        result = JSON.parse(response.text);
    } catch (error) {
        await markJob(job.id, 'failed', 'NETWORK');
        log('点菜提醒发送异常 user=' + job.user_id + '：' + error.message);
        return;
    }

    const errcode = Number(result.errcode) || 0;
    if (errcode === 0) {
        await markJob(job.id, 'sent', '');
        log('已发点菜提醒 user=' + job.user_id + ' kind=' + job.kind);
    } else if (errcode === 43101) {
        await markJob(job.id, 'skipped', '43101');
        log('点菜提醒无额度或已拒收 user=' + job.user_id);
    } else {
        await markJob(job.id, 'failed', String(errcode));
        log('点菜提醒失败 user=' + job.user_id + ' errcode=' + errcode + ' ' + (result.errmsg || ''));
    }
}

if (require.main === module) {
    main().catch((error) => {
        log('未捕获异常：' + (error && error.message ? error.message : String(error)));
        process.exit(1);
    });
}

// 导出纯函数：可以在本地用假数据验证字段映射，不需要联网、也不需要 appid。
// 挂成模块被 require 时不会触发 main()。
module.exports = { buildExpireData, buildDishData, nameText, warmText, daysText, dateText };
