'use strict';

/**
 * watchdog.js —— 自建后端（pg + postgrest + gateway）的探活 / 自愈 / 告警
 *
 * 由宿主 cron 每 5 分钟拉起一次，跑完就退：
 *   *​/5 * * * * /usr/bin/node /root/cloud/watchdog.js >> /var/log/watchdog.log 2>&1
 *
 * 为什么不用现成的 uptime 监控：这台机器只有 917MB 内存，多一个常驻进程就多一份
 * OOM 风险；cron 拉起的短命进程峰值内存不到 40MB、跑完立刻归还。
 *
 * 检查项（前四项是「硬」故障，会触发自愈；后四项只报警不动手）：
 *   containers  三个容器都在 running
 *   pg          docker exec pg pg_isready
 *   gateway     进 llm-proxy 容器里 HTTP 自测 /.cloud/healthz
 *   postgrest   进 llm-proxy 容器里 HTTP 自测 http://pgrst:3000/
 *   llm         进 llm-proxy 容器里 HTTP 自测 /llm/healthz（8788）
 *   reminder    /var/log/reminder.log 最近 30 分钟内被写过（cron 每 5 分钟一行）
 *   disk        / 使用率 < 88%
 *   mem         MemAvailable > 60MB
 *
 * 自愈：硬故障时执行 docker compose up -d（幂等，只会把缺的容器拉起来）。
 * 告警：连续 2 轮（≈10 分钟）确认才发，避免瞬时抖动误报；
 *       故障期间最多每 30 分钟提醒一次；恢复时补一条「已恢复」。
 *       站内信写 public.notice（用户下次打开小程序能看到），
 *       若配置了 WATCHDOG_WEBHOOK 则额外 POST 一份（飞书/企业微信/自建都兼容）。
 *
 * 可调环境变量：
 *   WATCHDOG_COMPOSE=/root/cloud/docker-compose.yml
 *   WATCHDOG_SECRETS=/root/cloud-secrets.env
 *   WATCHDOG_STATE_DIR=/var/lib/cloud-watchdog
 *   WATCHDOG_WEBHOOK=           留空则不推送
 *   WATCHDOG_FORCE_FAIL=        调试用，逗号分隔要强制判失败的检查项
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const COMPOSE_FILE = process.env.WATCHDOG_COMPOSE || '/root/cloud/docker-compose.yml';
const SECRETS_ENV = process.env.WATCHDOG_SECRETS || '/root/cloud-secrets.env';
const STATE_DIR = process.env.WATCHDOG_STATE_DIR || '/var/lib/cloud-watchdog';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WEBHOOK = process.env.WATCHDOG_WEBHOOK || '';
const REMINDER_LOG = '/var/log/reminder.log';
const REMINDER_STALE_MS = 30 * 60 * 1000;
const DISK_LIMIT_PCT = 88;
const MEM_MIN_MB = 60;
const RE_ALERT_MS = 30 * 60 * 1000;
const CONFIRM_ROUNDS = 2;
const HARD_CHECKS = ['containers', 'pg', 'gateway', 'postgrest'];
const FORCE_FAIL = new Set(
    String(process.env.WATCHDOG_FORCE_FAIL || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
);

function run(cmd, args, timeoutMs, input) {
    return execFileSync(cmd, args, {
        timeout: timeoutMs || 20000,
        encoding: 'utf8',
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        input: input
    });
}

function oneLine(value, limit) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const max = limit || 200;
    return text.length > max ? text.slice(0, max) + '…' : text;
}

// ---- 检查 ---------------------------------------------------------------------
function checkContainers() {
    let out;
    try {
        out = run('docker', ['inspect', '-f', '{{.Name}}={{.State.Running}}', 'pg', 'pgrst', 'llm-proxy']);
    } catch (error) {
        return { ok: false, detail: 'docker inspect 失败：' + oneLine(error.stderr || error.message, 120) };
    }
    const down = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/=true$/.test(line))
        .map((line) => line.split('=')[0].replace(/^\//, ''));
    if (down.length > 0) return { ok: false, detail: '未运行 ' + down.join(',') };
    return { ok: true, detail: '3 个都在' };
}

function checkPg() {
    try {
        run('docker', ['exec', 'pg', 'pg_isready', '-q', '-U', 'postgres']);
        return { ok: true, detail: 'ready' };
    } catch (error) {
        return { ok: false, detail: 'pg_isready 失败：' + oneLine(error.stderr || error.message, 120) };
    }
}

// 探针跑在 llm-proxy 容器里：宿主没装 curl 也无所谓，同一容器里 node 现成。
const GATEWAY_PROBE = [
    "const h=require('http');",
    "h.get('http://127.0.0.1:8787/.cloud/healthz',r=>{let n=0;r.on('data',c=>n+=c.length);",
    "r.on('end',()=>process.exit(r.statusCode===200&&n>0?0:1))}).on('error',()=>process.exit(1));"
].join('');

const PGRST_PROBE = [
    "const h=require('http');",
    "h.get('http://pgrst:3000/',r=>{let n=0;r.on('data',c=>n+=c.length);",
    "r.on('end',()=>process.exit(r.statusCode===200&&n>0?0:1))}).on('error',()=>process.exit(1));"
].join('');

const LLM_PROBE = [
    "const h=require('http');",
    "h.get('http://127.0.0.1:8788/llm/healthz',r=>{let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);",
    "r.on('end',()=>process.exit(r.statusCode===200&&b.includes('\"ok\":true')?0:1))}).on('error',()=>process.exit(1));"
].join('');

function probeInGatewayContainer(label, script) {
    try {
        run('docker', ['exec', 'llm-proxy', 'node', '-e', script], 15000);
        return { ok: true, detail: 'ok' };
    } catch (error) {
        return { ok: false, detail: label + ' 自测失败：' + oneLine(error.stderr || error.message, 120) };
    }
}

function checkGateway() {
    return probeInGatewayContainer('gateway', GATEWAY_PROBE);
}

function checkPostgrest() {
    return probeInGatewayContainer('postgrest', PGRST_PROBE);
}

function checkLlm() {
    return probeInGatewayContainer('llm-proxy', LLM_PROBE);
}

function checkReminder() {
    try {
        const stat = fs.statSync(REMINDER_LOG);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > REMINDER_STALE_MS) {
            return { ok: false, detail: 'reminder.log 已 ' + Math.round(ageMs / 60000) + ' 分钟没更新' };
        }
        return { ok: true, detail: Math.round(ageMs / 60000) + ' 分钟前写过' };
    } catch (error) {
        return { ok: false, detail: '读不到 ' + REMINDER_LOG };
    }
}

function checkDisk() {
    try {
        const out = run('df', ['-P', '/'], 8000);
        const line = out.trim().split('\n').pop() || '';
        const pct = Number.parseInt(line.split(/\s+/)[4], 10);
        if (!Number.isFinite(pct)) return { ok: true, detail: 'df 解析失败' };
        return pct >= DISK_LIMIT_PCT ? { ok: false, detail: '已用 ' + pct + '%' } : { ok: true, detail: pct + '%' };
    } catch {
        return { ok: true, detail: 'df 不可用' };
    }
}

function checkMem() {
    try {
        const text = fs.readFileSync('/proc/meminfo', 'utf8');
        const matched = /MemAvailable:\s+(\d+)\s+kB/.exec(text);
        if (!matched) return { ok: true, detail: '?' };
        const mb = Math.round(Number(matched[1]) / 1024);
        return mb < MEM_MIN_MB
            ? { ok: false, detail: '可用仅 ' + mb + 'MB' }
            : { ok: true, detail: mb + 'MB' };
    } catch {
        return { ok: true, detail: '?' };
    }
}

// ---- 自愈 ---------------------------------------------------------------------
function heal() {
    const args = ['compose'];
    if (fs.existsSync(SECRETS_ENV)) args.push('--env-file', SECRETS_ENV);
    args.push('-f', COMPOSE_FILE, 'up', '-d');
    try {
        run('docker', args, 120000);
        return '已执行 docker compose up -d';
    } catch (error) {
        return '自愈失败：' + oneLine(error.stderr || error.message, 160);
    }
}

// ---- 告警 ---------------------------------------------------------------------
function sqlLiteral(text) {
    return "'" + String(text == null ? '' : text).replace(/'/g, "''") + "'";
}

// 站内信：type=system，dedupe_key 带小时戳 → 同一小时最多一条，不会刷屏。
function notifyInApp(title, body, kind) {
    const stamp = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, ''); // YYYYMMDDHH
    const dedupe = 'system:watchdog:' + kind + ':' + stamp;
    const sql = 'insert into public.notice (space_id, user_id, type, title, body, dedupe_key) '
        + "select space_id, user_id, 'system', "
        + sqlLiteral(oneLine(title, 80)) + ', '
        + sqlLiteral(oneLine(body, 400)) + ', '
        + sqlLiteral(dedupe)
        + ' from public.couple_member on conflict (user_id, dedupe_key) do nothing;';
    try {
        run('docker', ['exec', 'pg', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], 20000);
        return true;
    } catch (error) {
        // 数据库本身挂了就写不进去，这很正常：故障期间的日志和 webhook 仍然是证据
        return false;
    }
}

function notifyWebhook(text) {
    if (!WEBHOOK) return;
    let target;
    try {
        target = new URL(WEBHOOK);
    } catch {
        return;
    }
    // 同时带飞书（msg_type/content）与企业微信（msgtype/text）的字段，谁认哪条就取哪条
    const payload = Buffer.from(JSON.stringify({
        msg_type: 'text',
        msgtype: 'text',
        content: { text: text },
        text: { content: text }
    }), 'utf8');
    const client = target.protocol === 'https:' ? https : http;
    try {
        const req = client.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
            timeout: 8000
        }, (res) => res.resume());
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.end(payload);
    } catch {
        // 推送失败不影响主流程
    }
}

// ---- 状态 ---------------------------------------------------------------------
function loadState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveState(state) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch {
        // 状态文件写不进去只会导致重复告警，不该让整轮检查失败
    }
}

// ---- 主流程 -------------------------------------------------------------------
const CHECKS = [
    ['containers', checkContainers],
    ['pg', checkPg],
    ['gateway', checkGateway],
    ['postgrest', checkPostgrest],
    ['llm', checkLlm],
    ['reminder', checkReminder],
    ['disk', checkDisk],
    ['mem', checkMem]
];

function main() {
    const state = loadState();
    state.fails = state.fails && typeof state.fails === 'object' ? state.fails : {};

    const results = [];
    for (const [name, checker] of CHECKS) {
        let result;
        if (FORCE_FAIL.has(name)) {
            result = { ok: false, detail: 'WATCHDOG_FORCE_FAIL 注入' };
        } else {
            try {
                result = checker();
            } catch (error) {
                result = { ok: false, detail: oneLine(error && error.message || error, 120) };
            }
        }
        results.push([name, result]);
        if (result.ok) delete state.fails[name];
        else state.fails[name] = (state.fails[name] || 0) + 1;
    }

    const failing = results.filter(([, result]) => !result.ok);
    const confirmed = failing.filter(([name]) => (state.fails[name] || 0) >= CONFIRM_ROUNDS);
    const hardDown = failing.some(([name]) => HARD_CHECKS.indexOf(name) >= 0);

    let healed = '';
    if (hardDown) healed = heal();

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    const parts = results.map(([name, result]) => name + '=' + (result.ok ? result.detail : '×(' + result.detail + ')'));
    console.log('[' + stamp + '] ' + (failing.length > 0 ? 'FAIL' : 'ok') + ' ' + parts.join(' '));
    if (healed) console.log('[' + stamp + '] ' + healed);

    const now = Date.now();
    if (confirmed.length > 0) {
        const names = confirmed.map(([name, result]) => name + '（' + result.detail + '）').join('；');
        const dueToAlert = !state.down || now - (state.lastAlertAt || 0) > RE_ALERT_MS;
        if (dueToAlert) {
            const title = '自建后端异常：' + confirmed.map(([name]) => name).join('/');
            const body = names + (healed ? '。' + healed : '');
            const inApp = notifyInApp(title, body, 'down');
            notifyWebhook(title + '。' + names);
            state.down = true;
            state.lastAlertAt = now;
            console.log('[' + stamp + '] 已告警（站内信 ' + (inApp ? '写入成功' : '写入失败') + '）：' + names);
        }
    } else if (state.down && failing.length === 0) {
        const inApp = notifyInApp('自建后端已恢复', '全部检查项恢复正常', 'up');
        notifyWebhook('自建后端已恢复');
        state.down = false;
        state.lastAlertAt = 0;
        console.log('[' + stamp + '] 已恢复（站内信 ' + (inApp ? '写入成功' : '写入失败') + '）');
    }

    saveState(state);
    process.exitCode = failing.length > 0 ? 1 : 0;
}

main();