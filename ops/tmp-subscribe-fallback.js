// 订阅消息整批失败降级的行为验证（纯桩，不联网、不真机）。
// 场景：微信 20001 会因一个坏模板把整批拒掉，旧代码会让好模板一起失效、
// 还把英文 errMsg 弹给用户。这里锁住新行为：好的照攒额度，坏的单独点名。
//
// 跑法：node ops/tmp-subscribe-fallback.js

const path = require('path');

// 探针自带夹具模板 ID，不读 utils/local-config.js：
// 这样新 clone 的人没有本地配置也能跑，也不会把真实模板 ID 写进仓库。
const EXPIRE = 'fixture-template-expire';
const DISH = 'fixture-template-dish';

// 用夹具替换 utils/config 的 SUBSCRIBE_TEMPLATES，再加载被测模块。
function stubConfig() {
    const configPath = path.join(__dirname, '..', 'utils', 'config.js');
    require.cache[configPath] = {
        id: configPath,
        filename: configPath,
        loaded: true,
        exports: { SUBSCRIBE_TEMPLATES: { expire: EXPIRE, dish: DISH } },
    };
}

function loadWithStub(behavior) {
    // 每个用例重新加载，避免模块内状态串味
    delete require.cache[require.resolve(path.join(__dirname, '..', 'utils', 'subscribe.js'))];
    stubConfig();
    const calls = [];
    global.wx = {
        requestSubscribeMessage(options) {
            calls.push(options.tmplIds.slice());
            const result = behavior(options.tmplIds);
            if (result.ok) {
                const res = {};
                const values = result.values || {};
                options.tmplIds.forEach((id) => {
                    res[id] = values[id] || 'accept';
                });
                options.success(res);
            } else {
                options.fail({ errCode: result.code, errMsg: 'requestSubscribeMessage:fail:' + result.msg });
            }
        },
    };
    const subscribe = require(path.join(__dirname, '..', 'utils', 'subscribe.js'));
    return { subscribe, calls };
}

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass += 1;
        console.log('  ok   ' + name);
    } else {
        fail += 1;
        console.log('  FAIL ' + name + '\n       got: ' + a + '\n       exp: ' + e);
    }
}

async function main() {
    console.log('1) 整批成功 → 两个额度都拿到，不进入降级');
    {
        const { subscribe, calls } = loadWithStub(() => ({ ok: true }));
        const r = await subscribe.request(['expire', 'dish']);
        check('accepted', r.accepted, [EXPIRE, DISH]);
        check('error', r.error, null);
        check('只调用一次', calls.length, 1);
    }

    console.log('2) 整批 20001，dish 是坏的那个 → expire 仍拿到额度，error 点名「点菜提醒」');
    {
        const { subscribe, calls } = loadWithStub((ids) => {
            if (ids.length > 1) return { ok: false, code: 20001, msg: 'No template data return, verify the template id exist' };
            if (ids[0] === DISH) return { ok: false, code: 20001, msg: 'No template data return, verify the template id exist' };
            return { ok: true };
        });
        const r = await subscribe.request(['expire', 'dish']);
        check('accepted', r.accepted, [EXPIRE]);
        check('error.code', r.error.code, 20001);
        check('error.message 点名', r.error.message, '「点菜提醒」模板不可用，请到公众平台核对');
        check('details 只有 dish', r.details.map((x) => x.label), ['点菜提醒']);
        check('调用 1 次整批 + 2 次单个', calls.length, 3);
    }

    console.log('3) 整批 20001 但逐个都成功 → 不判死，两个额度都拿到');
    {
        const { subscribe } = loadWithStub((ids) => {
            if (ids.length > 1) return { ok: false, code: 20001, msg: 'No template data return' };
            return { ok: true };
        });
        const r = await subscribe.request(['expire', 'dish']);
        check('accepted', r.accepted, [EXPIRE, DISH]);
        check('error', r.error, null);
    }

    console.log('4) 只请求一个模板且失败 → 不降级，原样透出');
    {
        const { subscribe, calls } = loadWithStub(() => ({ ok: false, code: 20001, msg: 'No template data return' }));
        const r = await subscribe.request(['dish']);
        check('error.code', r.error.code, 20001);
        check('error.message', r.error.message, '模板不可用，请到公众平台核对');
        check('只调用一次', calls.length, 1);
    }

    console.log('5) 用户在设置里关了订阅消息（20004）→ 中文引导，不进降级');
    {
        const { subscribe, calls } = loadWithStub(() => ({ ok: false, code: 20004, msg: 'main switch is off' }));
        const r = await subscribe.request(['expire', 'dish']);
        check('error.code', r.error.code, 20004);
        check('error.message', r.error.message, '你在设置里关掉了订阅消息，去「设置」里打开后才能收到提醒');
        check('只调用一次', calls.length, 1);
    }

    console.log('6) 用户拒绝 → 记 rejected，不报错');
    {
        const { subscribe } = loadWithStub(() => ({ ok: true, values: { [EXPIRE]: 'reject', [DISH]: 'reject' } }));
        const r = await subscribe.request(['expire', 'dish']);
        check('accepted', r.accepted, []);
        check('rejected 数量', r.rejected.length, 2);
        check('error', r.error, null);
    }

    console.log('7) 模板未配置（空槽位被过滤）→ 不弹窗，直接回「未配置」');
    {
        const { subscribe, calls } = loadWithStub(() => ({ ok: true }));
        const r = await subscribe.request(['shopping']);
        check('error.message', r.error.message, '订阅消息模板还没有配置，暂时收不到微信提醒');
        check('没调用微信 API', calls.length, 0);
    }

    console.log('\n通过 ' + pass + ' / 失败 ' + fail);
    process.exit(fail === 0 ? 0 : 1);
}

main();
