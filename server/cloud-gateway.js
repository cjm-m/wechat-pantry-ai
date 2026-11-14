'use strict';

/**
 * cloud-gateway.js —— 「我们的小家」自建后端入口（单进程，零第三方依赖）
 *
 * 为什么要这一层：
 *   NPM 里对外域名的 proxy host 指死 `http://llm-proxy:8787`，改它要动 GUI。
 *   本文件占用 8787 这个「名字」，把 llm-proxy 本体挤到同进程的 8788 上，
 *   于是「AI 中转 / 微信登录 / 数据库 REST」三件事共用一个对外端口，NPM 零改动。
 *
 * 路由表：
 *   POST /.cloud/auth/v1/login-wechat     微信 code 换令牌
 *   POST /.cloud/auth/v1/token            用 refresh_token 换 access_token
 *   GET  /.cloud/auth/v1/user/me          当前用户
 *   POST /.cloud/auth/v1/user/signout     退出（无状态，直接 200）
 *   POST /.cloud/auth/v1/{verification,verification/verify,signin,signup}  501（不支持邮箱登录）
 *   *    /.cloud/database/rest/<table>    → PostgREST（表 / rpc / 视图，透明代理）
 *   GET  /.cloud/healthz                  健康检查
 *   *    （其余全部）                       → llm-proxy :8788
 *
 * 限流（进程内滑动窗口，见「限流」一节；超限一律 HTTP 429 + code RATE_LIMITED + retry-after 头）：
 *   /.cloud/auth/v1/login-wechat  默认 20 次 / 10 分钟 / IP —— 每次请求都会真的打微信 jscode2session
 *   /.cloud/auth/v1/token         默认 60 次 / 10 分钟 / IP
 *   /.cloud/database/rest/*       默认 300 次 / 1 分钟 / IP
 *
 * 令牌设计（无状态，不落库）：
 *   access_token  = JWT HS256，payload {sub:"wx:<openid>", role:"authenticated", exp, iat}
 *                   —— 这串东西同时也是 PostgREST 的 JWT，中间没有翻译层
 *   refresh_token = "wbrt_" + b64url({sub,exp,jti}) + "." + b64url(HMAC-SHA256)
 *                   只用于 /.cloud/auth/v1/token，不参与数据面
 *
 * 必须的环境变量：
 *   WX_APPID / WX_SECRET          微信小程序（与 llm-proxy 共用）
 *   CLOUD_JWT_SECRET              ≥32 位随机串；必须与 PostgREST 的 jwt-secret 一致
 *   CLOUD_PUBLISHABLE_KEY         wbpk_ 前缀，客户端随包发送；留空则不校验
 * 可选：
 *   GATEWAY_PORT(8787) LLM_INTERNAL_PORT(8788) PGRST_URL(http://pgrst:3000)
 *   CLOUD_DB_ROLE(authenticated) CLOUD_ACCESS_TOKEN_TTL(7200) CLOUD_REFRESH_TOKEN_TTL(2592000)
 */

const http = require('http');
const crypto = require('crypto');

// ---- 端口 -------------------------------------------------------------------
const GATEWAY_PORT = toInt(process.env.GATEWAY_PORT, 8787);
const LLM_INTERNAL_PORT = toInt(process.env.LLM_INTERNAL_PORT, 8788);

// llm-proxy 在模块顶层读 LLM_PORT 并立刻 listen，所以必须先改环境再 require。
process.env.LLM_PORT = String(LLM_INTERNAL_PORT);
require('./llm-proxy.js');

// ---- 配置 -------------------------------------------------------------------
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
const JWT_SECRET = process.env.CLOUD_JWT_SECRET || '';
const PUBLISHABLE_KEY = process.env.CLOUD_PUBLISHABLE_KEY || '';
const ACCESS_TTL = toInt(process.env.CLOUD_ACCESS_TOKEN_TTL, 7200);
const REFRESH_TTL = toInt(process.env.CLOUD_REFRESH_TOKEN_TTL, 2592000);
const DB_ROLE = process.env.CLOUD_DB_ROLE || 'authenticated';
const PGRST_URL = process.env.PGRST_URL || 'http://pgrst:3000';
const MAX_BODY_BYTES = toInt(process.env.CLOUD_MAX_BODY_BYTES, 2 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = toInt(process.env.CLOUD_UPSTREAM_TIMEOUT_MS, 30000);
const WX_HTTP_TIMEOUT_MS = toInt(process.env.CLOUD_WX_TIMEOUT_MS, 8000);

// 限流额度（改这几个键只需 restart 容器，不用改代码）
const LOGIN_WINDOW_MS = toInt(process.env.CLOUD_LOGIN_WINDOW_MS, 10 * 60 * 1000);
const LOGIN_MAX = toInt(process.env.CLOUD_LOGIN_MAX, 20);
const REFRESH_WINDOW_MS = toInt(process.env.CLOUD_REFRESH_WINDOW_MS, 10 * 60 * 1000);
const REFRESH_MAX = toInt(process.env.CLOUD_REFRESH_MAX, 60);
const DB_WINDOW_MS = toInt(process.env.CLOUD_DB_WINDOW_MS, 60 * 1000);
const DB_MAX = toInt(process.env.CLOUD_DB_MAX, 300);
// 网关只暴露在容器网内、前面是 NPM，X-Forwarded-For 由 NPM 追加、可信；
// 若哪天直接对公网开放，把 CLOUD_TRUST_PROXY 设成 0，按 socket 地址限流。
const TRUST_PROXY = String(process.env.CLOUD_TRUST_PROXY || '1') !== '0';

function toInt(raw, fallback) {
    const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function checkConfig() {
    const missing = [];
    if (!WX_APPID) missing.push('WX_APPID');
    if (!WX_SECRET) missing.push('WX_SECRET');
    if (!JWT_SECRET) missing.push('CLOUD_JWT_SECRET');
    if (missing.length > 0) {
        console.error('[gateway] 缺少环境变量：' + missing.join(', '));
        process.exit(1);
    }
    if (JWT_SECRET.length < 32) {
        console.error('[gateway] CLOUD_JWT_SECRET 太短，至少 32 位（openssl rand -hex 32）');
        process.exit(1);
    }
    if (PUBLISHABLE_KEY && !/^wbpk_/.test(PUBLISHABLE_KEY)) {
        console.error('[gateway] CLOUD_PUBLISHABLE_KEY 必须以 wbpk_ 开头（SDK 会同步校验格式）');
        process.exit(1);
    }
}

// ---- 小工具 -----------------------------------------------------------------
function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
    return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(text) {
    return b64url(crypto.createHmac('sha256', JWT_SECRET).update(text).digest());
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function nowMs() {
    return Date.now();
}

// ---- 限流 ---------------------------------------------------------------------
// 为什么必须有：login-wechat 每收到一次请求就真的去调微信 jscode2session。
// 不设上限时，任何人拿一枚 publishableKey（它随小程序包发布，反编译就能拿到）
// 打这个端点，都能把微信侧调用量/风控打爆；appid 一旦被限，两个人的小程序
// 会一起登不上 —— 而 appid 是换不了的（openid 绑着现有数据）。
//
// 为什么放进程内存而不是 redis/文件：零依赖、零 IO、无额外容器；
// 代价是容器重启清零（重启本身很罕见，且重启期间没人能打）。
// 桶键 = 桶名 + 客户端 IP，一小时清一次过期桶，避免 Map 随 IP 数无限增长。
const rateBuckets = new Map();

function clientIp(req) {
    if (TRUST_PROXY) {
        // 优先级按「伪造难度」排，而不是按常见程度排：
        // 1) cf-connecting-ip —— Cloudflare 用自己的观测值覆写，客户端塞什么都会被盖掉，
        //    这是链路上唯一一个能代表「真实访客」且无法伪造的头。
        const cf = String(req.headers['cf-connecting-ip'] || '').trim();
        if (cf) return cf;
        // 2) x-real-ip —— NPM 用 proxy_set_header X-Real-IP $remote_addr 覆写，
        //    只有绕过 Cloudflare 直连源站时才会走到这里（那时它正好是真实地址）。
        const real = String(req.headers['x-real-ip'] || '').trim();
        if (real) return real;
        // 3) x-forwarded-for —— 注意它是「追加」语义：Cloudflare 和 NPM 都往后面加，
        //    所以第一段完全由客户端决定（`X-Forwarded-For: 1.2.3.4` 会原样留在最前）。
        //    取最后一段才是最近一跳真正看到的地址。
        const forwarded = String(req.headers['x-forwarded-for'] || '');
        const hops = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
        if (hops.length > 0) return hops[hops.length - 1];
    }
    const socket = req.socket || {};
    return String(socket.remoteAddress || 'unknown');
}

function rateLimit(bucket, ip, windowMs, max) {
    const now = nowMs();
    const key = bucket + '|' + ip;
    let entry = rateBuckets.get(key);
    if (!entry || now - entry.start >= windowMs) {
        entry = { start: now, count: 0 };
        rateBuckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= max) return { limited: false };
    return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - entry.start)) / 1000))
    };
}

function rejectRate(res, hit, where, ip) {
    console.warn('[gateway] 限流命中 ' + where + ' ip=' + ip + ' retryAfter=' + hit.retryAfterSec + 's');
    res.setHeader('retry-after', String(hit.retryAfterSec));
    return fail(res, 429, 'RATE_LIMITED', '请求过于频繁，请 ' + hit.retryAfterSec + ' 秒后再试');
}

const rateSweeper = setInterval(() => {
    const now = nowMs();
    const maxWindow = Math.max(LOGIN_WINDOW_MS, REFRESH_WINDOW_MS, DB_WINDOW_MS);
    for (const [key, entry] of rateBuckets) {
        if (now - entry.start > maxWindow * 2) rateBuckets.delete(key);
    }
}, 3600000);
if (typeof rateSweeper.unref === 'function') rateSweeper.unref();

function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store'
    });
    res.end(body);
}

function fail(res, status, code, message) {
    sendJson(res, status, { ok: false, code: code, message: message });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) return resolve({});
            try {
                const parsed = JSON.parse(text);
                resolve(parsed && typeof parsed === 'object' ? parsed : {});
            } catch {
                reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'BAD_JSON' }));
            }
        });
        req.on('error', reject);
    });
}

// ---- 令牌 -------------------------------------------------------------------
function signAccessToken(openid, profile) {
    const iat = Math.floor(nowMs() / 1000);
    const payload = {
        sub: 'wx:' + openid,
        role: DB_ROLE,
        iat: iat,
        exp: iat + ACCESS_TTL,
        iss: 'homelab-gateway'
    };
    if (profile && profile.name) payload.name = profile.name;
    if (profile && profile.avatar_url) payload.avatar_url = profile.avatar_url;
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    return head + '.' + body + '.' + hmac(head + '.' + body);
}

function verifyAccessToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expected = hmac(parts[0] + '.' + parts[1]);
    if (!safeEqual(expected, parts[2])) return null;
    let payload;
    try {
        payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
        return null;
    }
    if (!payload || typeof payload.sub !== 'string' || !payload.sub) return null;
    if (Number(payload.exp) * 1000 <= nowMs()) return null;
    return payload;
}

function signRefreshToken(openid) {
    const payload = b64url(JSON.stringify({
        sub: 'wx:' + openid,
        exp: nowMs() + REFRESH_TTL * 1000,
        jti: crypto.randomBytes(9).toString('hex')
    }));
    return 'wbrt_' + payload + '.' + hmac(payload);
}

function verifyRefreshToken(token) {
    const raw = String(token || '');
    if (!raw.startsWith('wbrt_')) return null;
    const body = raw.slice('wbrt_'.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = body.slice(0, dot);
    const sig = body.slice(dot + 1);
    if (!safeEqual(hmac(payload), sig)) return null;
    let parsed;
    try {
        parsed = JSON.parse(fromB64url(payload).toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed.sub !== 'string') return null;
    if (Number(parsed.exp) <= nowMs()) return null;
    return parsed;
}

function issueSession(openid, profile) {
    return {
        access_token: signAccessToken(openid, profile),
        refresh_token: signRefreshToken(openid),
        expires_in: ACCESS_TTL,
        sub: 'wx:' + openid,
        name: (profile && profile.name) || null,
        avatar_url: (profile && profile.avatar_url) || null,
        is_anonymous: false
    };
}

function bearer(req) {
    const header = String(req.headers['authorization'] || '');
    if (!/^Bearer\s+/i.test(header)) return '';
    return header.replace(/^Bearer\s+/i, '').trim();
}

// ---- 微信 code2session -------------------------------------------------------
function code2session(code) {
    const url = 'https://api.weixin.qq.com/sns/jscode2session'
        + '?appid=' + encodeURIComponent(WX_APPID)
        + '&secret=' + encodeURIComponent(WX_SECRET)
        + '&js_code=' + encodeURIComponent(code)
        + '&grant_type=authorization_code';

    return new Promise((resolve, reject) => {
        const request = require('https').get(url, { timeout: WX_HTTP_TIMEOUT_MS }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    return reject(new Error('微信返回非 JSON：' + text.slice(0, 120)));
                }
                if (parsed && parsed.openid) return resolve(parsed);
                reject(new Error('微信登录失败：' + (parsed && (parsed.errmsg || parsed.errcode) || '未知错误')));
            });
        });
        request.on('timeout', () => {
            request.destroy(new Error('code2session 超时'));
        });
        request.on('error', reject);
    });
}

// ---- 认证路由 -----------------------------------------------------------------
async function handleAuth(req, res, pathname) {
    if (!gatePublishableKey(req, res)) return;

    // 限流放在 publishableKey 之后：拿到不起验证码的请求（比如错 key）先被 401 挡掉，
    // 不占额度，免得一次误配就把自己和家人锁在外面。
    const ip = clientIp(req);
    if (req.method === 'POST' && pathname === '/.cloud/auth/v1/login-wechat') {
        const hit = rateLimit('login', ip, LOGIN_WINDOW_MS, LOGIN_MAX);
        if (hit.limited) return rejectRate(res, hit, 'login', ip);
    }
    if (req.method === 'POST' && pathname === '/.cloud/auth/v1/token') {
        const hit = rateLimit('refresh', ip, REFRESH_WINDOW_MS, REFRESH_MAX);
        if (hit.limited) return rejectRate(res, hit, 'refresh', ip);
    }

    if (req.method === 'POST' && pathname === '/.cloud/auth/v1/login-wechat') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return fail(res, error.status || 400, error.code || 'BAD_REQUEST', error.message);
        }
        const code = String(body.code || '').trim();
        if (!code) return fail(res, 400, 'BAD_REQUEST', '缺少 code');
        let session;
        try {
            session = await code2session(code);
        } catch (error) {
            return fail(res, 401, 'WX_LOGIN_FAILED', error.message);
        }
        const profile = {
            name: body.name ? String(body.name).slice(0, 40) : null,
            avatar_url: body.avatar_url ? String(body.avatar_url).slice(0, 512) : null
        };
        console.log('[gateway] login ok sub=wx:' + session.openid);
        return sendJson(res, 200, issueSession(session.openid, profile));
    }

    if (req.method === 'POST' && pathname === '/.cloud/auth/v1/token') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return fail(res, error.status || 400, error.code || 'BAD_REQUEST', error.message);
        }
        const grant = String(body.grant_type || '');
        if (grant && grant !== 'refresh_token') {
            return fail(res, 400, 'UNSUPPORTED_GRANT', '只支持 grant_type=refresh_token');
        }
        const parsed = verifyRefreshToken(body.refresh_token);
        if (!parsed) return fail(res, 401, 'INVALID_REFRESH_TOKEN', 'refresh_token 无效或已过期');
        const openid = parsed.sub.replace(/^wx:/, '');
        return sendJson(res, 200, issueSession(openid, null));
    }

    if (pathname === '/.cloud/auth/v1/user/me') {
        const payload = verifyAccessToken(bearer(req));
        if (!payload) return fail(res, 401, 'UNAUTHORIZED', '缺少或无法验证访问令牌');
        return sendJson(res, 200, {
            id: payload.sub,
            name: payload.name || null,
            avatar_url: payload.avatar_url || null,
            email: null,
            phone: null,
            provider: 'wechat'
        });
    }

    if (req.method === 'POST' && pathname === '/.cloud/auth/v1/user/signout') {
        // 无状态令牌：客户端丢掉本地副本即可，服务端无需吊销
        return sendJson(res, 200, { ok: true });
    }

    if (/^\/\.cloud\/auth\/v1\/(verification|signin|signup)(\/verify)?$/.test(pathname)) {
        return fail(res, 501, 'NOT_SUPPORTED', '本项目只支持微信登录（邮箱验证码通道未实现）');
    }

    return fail(res, 404, 'NOT_FOUND', '未知的认证接口：' + pathname);
}

function gatePublishableKey(req, res) {
    if (!PUBLISHABLE_KEY) return true;
    const given = String(req.headers['x-wb-webapp-access-key'] || '');
    if (given === PUBLISHABLE_KEY) return true;
    fail(res, 401, 'INVALID_PUBLISHABLE_KEY', 'x-wb-webapp-access-key 不匹配');
    return false;
}

// ---- 反向代理 -----------------------------------------------------------------
const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });

function proxyTo(targetBase, req, res, stripPrefix) {
    let target;
    try {
        target = new URL(targetBase);
    } catch {
        return fail(res, 500, 'BAD_UPSTREAM', '上游地址配置错误：' + targetBase);
    }

    let path = req.url || '/';
    if (stripPrefix && path.startsWith(stripPrefix)) path = path.slice(stripPrefix.length) || '/';
    if (!path.startsWith('/')) path = '/' + path;

    const headers = Object.assign({}, req.headers);
    delete headers['host'];
    delete headers['connection'];
    delete headers['accept-encoding']; // 让上游直出，避免 gzip 与 SSE 混在一起

    const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: path,
        headers: headers,
        agent: target.protocol === 'http:' ? agent : undefined,
        timeout: UPSTREAM_TIMEOUT_MS
    };

    const upstream = (target.protocol === 'https:' ? require('https') : http).request(options, (upstreamRes) => {
        const outHeaders = Object.assign({}, upstreamRes.headers);
        // 让 NPM / Cloudflare 都别缓冲 SSE
        outHeaders['x-accel-buffering'] = 'no';
        outHeaders['cache-control'] = outHeaders['cache-control'] || 'no-store';
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
    });

    upstream.on('timeout', () => {
        upstream.destroy(new Error('上游超时 ' + UPSTREAM_TIMEOUT_MS + 'ms'));
    });

    upstream.on('error', (error) => {
        console.error('[gateway] 上游错误 ' + targetBase + ' ' + req.method + ' ' + path + ' → ' + error.message);
        if (!res.headersSent) {
            fail(res, 502, 'UPSTREAM_ERROR', '上游不可达：' + error.message);
        } else {
            res.end();
        }
    });

    req.pipe(upstream);
}

// ---- 主路由 -------------------------------------------------------------------
function route(req, res) {
    let pathname;
    try {
        pathname = new URL(req.url, 'http://gateway.local').pathname;
    } catch {
        return fail(res, 400, 'BAD_REQUEST', '无法解析请求路径');
    }

    if (pathname === '/.cloud/healthz') {
        return sendJson(res, 200, {
            ok: true,
            gateway: true,
            postgrest: PGRST_URL,
            llm: 'http://127.0.0.1:' + LLM_INTERNAL_PORT,
            accessTtl: ACCESS_TTL,
            publishableKeyGated: Boolean(PUBLISHABLE_KEY),
            rateLimit: {
                loginPer10min: LOGIN_MAX,
                refreshPer10min: REFRESH_MAX,
                databasePerMin: DB_MAX,
                buckets: rateBuckets.size
            },
            uptime: Math.round(process.uptime())
        });
    }

    if (pathname.startsWith('/.cloud/auth/')) {
        return handleAuth(req, res, pathname).catch((error) => {
            console.error('[gateway] auth 异常：' + (error && error.stack || error));
            if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务器内部错误');
        });
    }

    if (pathname.startsWith('/.cloud/database/rest/')) {
        if (!gatePublishableKey(req, res)) return;
        const ip = clientIp(req);
        const hit = rateLimit('db', ip, DB_WINDOW_MS, DB_MAX);
        if (hit.limited) return rejectRate(res, hit, 'database', ip);
        return proxyTo(PGRST_URL, req, res, '/.cloud/database/rest');
    }

    // 其余全部交给 llm-proxy（含 /healthz、/llm/*）
    return proxyTo('http://127.0.0.1:' + LLM_INTERNAL_PORT, req, res, null);
}

checkConfig();

const server = http.createServer((req, res) => {
    const startedAt = nowMs();
    res.on('close', () => {
        console.log('[gateway] ' + req.method + ' ' + req.url + ' ' + res.statusCode + ' ' + (nowMs() - startedAt) + 'ms');
    });
    try {
        route(req, res);
    } catch (error) {
        console.error('[gateway] 未捕获异常：' + (error && error.stack || error));
        if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务器内部错误');
        else res.end();
    }
});

server.headersTimeout = 65000;
server.requestTimeout = 300000;
server.keepAliveTimeout = 65000;

server.listen(GATEWAY_PORT, process.env.GATEWAY_HOST || '0.0.0.0', () => {
    console.log('[gateway] listening on ' + (process.env.GATEWAY_HOST || '0.0.0.0') + ':' + GATEWAY_PORT
        + '，认证 + 数据库透传，AI 转发到 127.0.0.1:' + LLM_INTERNAL_PORT);
    console.log('[gateway] postgrest=' + PGRST_URL + ' accessTtl=' + ACCESS_TTL + 's refreshTtl=' + REFRESH_TTL + 's');
});