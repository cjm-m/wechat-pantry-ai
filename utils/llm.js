// 统一的模型通道适配层。
//
// 对外暴露的方法与 cloud.llm 的接口约定完全一致：
//   llm.models.list()                    → [{ id, name, supportsImages, disabled }]
//   llm.chat.completions.create(params)  → 可以 for await 的异步流
// 所以 cooking / vision / shelf / dish-recipe 里的「读流 → 拼 text → 看 finish_reason」
// 三段式逻辑一行都不用改，只换 require 和参数来源。
//
// 三条底层通道，按 model-config.PROVIDER 三选一：
//   'server'   默认。走你自己的服务器（server/llm-proxy.js）转发到 NewAPI。
//              支持 SSE 流式，逐字进度真实可见；无冷启动；不产生云开发费用。
//   'newapi'   微信云函数转发（上一版方案，保留作备用）。云函数不支持流式，进度只在末尾跳一次。
//   'platform' 内置免密钥通道（最后兜底/回滚）。
//
// params 结构（三条通道共用同一份对象，各取所需字段）：
//   {
//     task: 'recipe' | 'vision' | 'shelf' | 'dish_used',
//     input: {...},        // server / newapi 通道的结构化入参；提示词在服务端
//     model, temperature,
//     messages,            // 仅 platform 通道使用
//     signal, timeoutMs,
//   }
//
// 关于超时：小程序 wx.request 的硬上限是 60 秒（传更大值会被静默截断），三条通道都一样。
// 自建通道的收益不是「等更久」，而是「首字节更早到、进度可见」，不会出现盯着转圈等到超时的情况。

const config = require('./model-config');

const DEFAULT_TIMEOUT_MS = 58000;
const MODELS_TIMEOUT_MS = 10000;
const LOGIN_TIMEOUT_MS = 10000;
const TOKEN_STORAGE_KEY = 'couple_llm_token';
const TOKEN_SAFETY_MS = 120000;

let cloudReady = false;
let modelsCache = null;
let modelsCacheProvider = '';
let tokenMemory = null;

function appError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isServer() {
    return config.PROVIDER === 'server';
}

function isNewApi() {
    return config.PROVIDER === 'newapi';
}

function isPlatform() {
    return config.PROVIDER === 'platform';
}

function wxApi() {
    return typeof wx === 'undefined' ? null : wx;
}

function trimSlash(text) {
    return String(text || '').trim().replace(/\/+$/, '');
}

function serverUrl(path) {
    return trimSlash(config.SERVER_BASE) + path;
}

// ── 云开发（仅 newapi / vision 上传用）─────────────────────────────────────

function ensureCloud() {
    if (cloudReady) return;
    const api = wxApi();
    if (!api || !api.cloud || typeof api.cloud.callFunction !== 'function') {
        throw appError('NO_CLOUD', '还没开通微信云开发，暂时连不上自建模型');
    }
    try {
        if (typeof api.cloud.init === 'function') {
            if (config.CLOUD_ENV) {
                api.cloud.init({ env: config.CLOUD_ENV, traceUser: true });
            } else {
                api.cloud.init({ traceUser: true });
            }
        }
    } catch (error) {
        // 已经初始化过：忽略。环境配错会由 callFunction 报明确的错。
    }
    cloudReady = true;
}

// ── 字节 / UTF-8 解码 ──────────────────────────────────────────────────────
// 小程序没有 TextDecoder，而且一个中文字符 3 字节，很容易被切在两个 chunk 之间。
// 这里自己做增量解码：不完整的字节序列留到下一块，避免出现「锟斤拷」。

function fromCodePoint(code) {
    if (code <= 0xffff) return String.fromCharCode(code);
    const shifted = code - 0x10000;
    return String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
}

function toBytes(input, pending) {
    let view = null;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        view = new Uint8Array(input);
    } else if (input && typeof ArrayBuffer !== 'undefined' && input.buffer instanceof ArrayBuffer) {
        view = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.length || 0);
    } else if (input && typeof input.length === 'number') {
        view = new Uint8Array(input);
    }

    if (!view) return pending && pending.length > 0 ? pending : null;
    if (!pending || pending.length === 0) return view;

    const merged = new Uint8Array(pending.length + view.length);
    merged.set(pending, 0);
    merged.set(view, pending.length);
    return merged;
}

function createUtf8Decoder() {    let pending = null;
    return function decode(input) {
        const bytes = toBytes(input, pending);
        pending = null;
        if (!bytes || bytes.length === 0) return '';

        let out = '';
        let i = 0;
        while (i < bytes.length) {
            const first = bytes[i];
            if (first < 0x80) {
                out += String.fromCharCode(first);
                i += 1;
                continue;
            }

            let length = 0;
            let code = 0;
            if ((first & 0xe0) === 0xc0) {
                length = 2;
                code = first & 0x1f;
            } else if ((first & 0xf0) === 0xe0) {
                length = 3;
                code = first & 0x0f;
            } else if ((first & 0xf8) === 0xf0) {
                length = 4;
                code = first & 0x07;
            } else {
                // 非法起始字节，跳过
                i += 1;
                continue;
            }

            if (i + length > bytes.length) break; // 不完整，留给下一块

            let valid = true;
            for (let k = 1; k < length; k += 1) {
                const next = bytes[i + k];
                if ((next & 0xc0) !== 0x80) {
                    valid = false;
                    break;
                }
                code = (code << 6) | (next & 0x3f);
            }
            if (!valid) {
                i += length;
                continue;
            }
            out += fromCodePoint(code);
            i += length;
        }

        if (i < bytes.length) pending = bytes.slice(i);
        return out;
    };
}

// ── SSE 解析 ───────────────────────────────────────────────────────────────
// 只关心 data: 行；`:` 开头的是保活注释，直接丢。行尾可能被切成半个，用 buffer 兜住。

function createSseParser(onData) {
    let buffer = '';
    return {
        push(text) {
            if (!text) return;
            buffer += text;
            let index = buffer.indexOf('\n');
            while (index >= 0) {
                let line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (line.length > 0 && line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
                if (line !== '' && line.charAt(0) !== ':' && line.indexOf('data:') === 0) {
                    onData(line.slice(5).trim());
                }
                index = buffer.indexOf('\n');
            }
        },
        flush() {
            const line = buffer.trim();
            buffer = '';
            if (line !== '' && line.indexOf('data:') === 0) onData(line.slice(5).trim());
        },
    };
}

// ── 异步通道：把「回调式到达」转成 for await 能消费的迭代器 ────────────────

function createChannel() {
    const buffer = [];
    const waiters = [];
    let closed = false;
    let failure = null;

    function drain() {
        while (waiters.length > 0) {
            const waiter = waiters.shift();
            if (buffer.length > 0) {
                waiter.resolve({ value: buffer.shift(), done: false });
            } else if (failure) {
                waiter.reject(failure);
            } else {
                waiter.resolve({ value: undefined, done: true });
            }
        }
    }

    return {
        push(value) {
            if (closed) return;
            buffer.push(value);
            drain();
        },
        close() {
            closed = true;
            drain();
        },
        error(error) {
            if (failure) return;
            failure = error;
            closed = true;
            drain();
        },
        iterator: {
            next() {
                if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false });
                if (failure) {
                    const error = failure;
                    return Promise.reject(error);
                }
                if (closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
            },
            return() {
                closed = true;
                return Promise.resolve({ value: undefined, done: true });
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        },
    };
}

// ── 登录态（server 通道）──────────────────────────────────────────────────

function readStoredToken() {
    if (tokenMemory && tokenMemory.exp > Date.now() + TOKEN_SAFETY_MS) return tokenMemory;
    const api = wxApi();
    if (!api || typeof api.getStorageSync !== 'function') return null;
    try {
        const saved = api.getStorageSync(TOKEN_STORAGE_KEY);
        if (saved && typeof saved.token === 'string' && saved.exp > Date.now() + TOKEN_SAFETY_MS) {
            tokenMemory = saved;
            return saved;
        }
    } catch (error) {
        // 存储不可用就每次重新登录
    }
    return null;
}

function saveToken(token, expiresIn) {
    const seconds = Number(expiresIn) > 0 ? Number(expiresIn) : 0;
    const record = { token: token, exp: Date.now() + Math.max(60, seconds) * 1000 - TOKEN_SAFETY_MS };
    tokenMemory = record;
    const api = wxApi();
    if (!api || typeof api.setStorageSync !== 'function') return;
    try {
        api.setStorageSync(TOKEN_STORAGE_KEY, record);
    } catch (error) {
        // 存不上就只用本次会话的内存副本
    }
}

function clearToken() {
    tokenMemory = null;
    const api = wxApi();
    if (!api || typeof api.removeStorageSync !== 'function') return;
    try {
        api.removeStorageSync(TOKEN_STORAGE_KEY);
    } catch (error) {
        // 忽略
    }
}

function wxLogin() {
    return new Promise((resolve, reject) => {
        const api = wxApi();
        if (!api || typeof api.login !== 'function') {
            reject(appError('NO_WX', '微信登录不可用'));
            return;
        }
        api.login({
            success: (res) => {
                if (res && res.code) resolve(res.code);
                else reject(appError('LOGIN_FAILED', '微信登录没有返回 code'));
            },
            fail: () => reject(appError('LOGIN_FAILED', '微信登录失败，检查网络后重试')),
        });
    });
}

function parseJsonBody(res) {
    const data = res ? res.data : null;
    if (!data) return null;
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }
    if (typeof data === 'object' && !(typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer)) return data;
    return null;
}

// wx.request 的通用封装：带取消、超时、可选的分块回调。
function rawRequest(options) {
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) || Number(config.CLIENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const signal = opts.signal || null;
    const chunked = typeof opts.onChunk === 'function';

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let requestTask = null;
        let sawChunk = false;

        function onAbort() {
            settle(reject, appError('abort', '已取消'));
            if (requestTask && typeof requestTask.abort === 'function') {
                try {
                    requestTask.abort();
                } catch (error) {
                    // 忽略
                }
            }
        }

        function settle(fn, value) {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && typeof signal.removeEventListener === 'function') {
                try {
                    signal.removeEventListener('abort', onAbort);
                } catch (error) {
                    // 忽略
                }
            }
            fn(value);
        }

        if (signal) {
            if (signal.aborted) {
                settle(reject, appError('abort', '已取消'));
                return;
            }
            if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
        }

        timer = setTimeout(() => {
            settle(reject, appError('timeout', '模型响应超时，稍后再试'));
            if (requestTask && typeof requestTask.abort === 'function') {
                try {
                    requestTask.abort();
                } catch (error) {
                    // 忽略
                }
            }
        }, timeoutMs);

        const header = { 'Content-Type': 'application/json' };
        if (opts.token) header.Authorization = 'Bearer ' + opts.token;
        if (chunked) header.Accept = 'text/event-stream';

        try {
            requestTask = wxApi().request({
                url: opts.url,
                method: opts.method || 'GET',
                data: opts.data,
                header: header,
                timeout: Math.min(timeoutMs, 60000),
                // 分块接收必须关掉 HTTP/2，否则真机上收不到分块。
                enableHttp2: false,
                enableChunked: chunked,
                responseType: chunked ? 'arraybuffer' : 'text',
                success: (res) => {
                    // 兜底：老基础库没有 onChunkReceived（或它在 responseType 上退化）时，
                    // 分块回调一次都不会触发。此时整段响应仍在 res.data 里，补发一次，
                    // 否则会静默得到空文本——比报错更难查。
                    if (chunked && !sawChunk && res && res.data) {
                        try {
                            opts.onChunk(res.data);
                        } catch (error) {
                            // 忽略：解析交给上层
                        }
                    }
                    settle(resolve, res);
                },
                fail: (error) => settle(reject, mapRequestError(error)),
            });
        } catch (error) {
            settle(reject, mapRequestError(error));
            return;
        }

        if (typeof opts.onTask === 'function') opts.onTask(requestTask);

        if (chunked && requestTask && typeof requestTask.onChunkReceived === 'function') {
            requestTask.onChunkReceived((res) => {
                sawChunk = true;
                opts.onChunk(res ? res.data : null);
            });
        }
    });
}

// 当前运行包的 appid。迁移期用来判断"报错的包到底属于哪个小程序"——
// 换了 appid 但工具没切换时，最典型的症状就是后台配了域名、手机仍报 not in domain list。
function currentAppId() {
    const api = wxApi();
    try {
        if (api && typeof api.getAccountInfoSync === 'function') {
            const info = api.getAccountInfoSync();
            const appId = info && info.miniProgram ? info.miniProgram.appId : '';
            if (appId) return appId;
        }
    } catch (error) {
        // 老基础库没有这个接口，忽略
    }
    return '';
}

function mapRequestError(error) {
    const message = (error && (error.errMsg || error.message)) || '网络请求失败';
    if (/timeout|timed ?out/i.test(message)) return appError('timeout', '模型响应超时，稍后再试');
    if (/abort/i.test(message)) return appError('abort', '已取消');
    if (/domain|合法域名|url not in domain list/i.test(message)) {
        // 这条错误是客户端本地拦截，请求根本没发出去。
        // 文案里带上实际请求的域名，避免在"配了哪个 host"上来回猜。
        const host = String(config.SERVER_BASE || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        const appId = currentAppId();
        return appError('DOMAIN_BLOCKED', '域名没生效：' + host + ' 不在当前生效的 request 合法域名里'
            + (appId ? '（当前 appid: ' + appId + '）' : ''));
    }
    if (/ssl|certificate|handshake/i.test(message)) return appError('TLS', 'HTTPS 证书校验失败，检查证书是否有效并与域名一致');
    return appError('NETWORK', message);
}

async function ensureToken(force) {
    if (!force) {
        const cached = readStoredToken();
        if (cached) return cached.token;
    }

    const code = await wxLogin();
    const res = await rawRequest({
        url: serverUrl(config.LOGIN_PATH),
        method: 'POST',
        data: { code: code },
        timeoutMs: LOGIN_TIMEOUT_MS,
    });

    const body = parseJsonBody(res);
    if (!body || body.ok !== true || typeof body.token !== 'string' || body.token === '') {
        throw appError(
            (body && body.code) || 'LOGIN_FAILED',
            (body && body.message) || '登录转发服务失败，检查服务器是否运行'
        );
    }
    saveToken(body.token, body.expiresIn);
    return body.token;
}

// 带登录态的普通请求；401 时重登一次再试。
async function serverFetch(path, options) {
    const opts = options || {};
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await ensureToken(attempt > 0);
        const res = await rawRequest({
            url: serverUrl(path),
            method: opts.method || 'GET',
            data: opts.data,
            token: token,
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
        });
        if (res && res.statusCode === 401 && attempt === 0) {
            clearToken();
            continue;
        }
        return res;
    }
    throw appError('UNAUTHORIZED', '登录已失效，请重新进入小程序');
}

// ── server 通道：SSE 流式 ──────────────────────────────────────────────────

function buildServerPayload(src) {
    const payload = Object.assign({}, src.input || {});
    payload.task = src.task || 'recipe';
    payload.stream = true;
    if (src.model) payload.model = src.model;
    if (typeof src.temperature === 'number') payload.temperature = src.temperature;
    return payload;
}

function createViaServer(params) {
    const src = params || {};
    const payload = buildServerPayload(src);

    return (async function* run() {
        const channel = createChannel();
        const state = { task: null };

        function detach() {
            const signal = src.signal;
            if (signal && typeof signal.removeEventListener === 'function' && state.onAbort) {
                try {
                    signal.removeEventListener('abort', state.onAbort);
                } catch (error) {
                    // 忽略
                }
            }
        }

        function attach() {
            const signal = src.signal;
            if (!signal) return;
            if (signal.aborted) {
                channel.error(appError('abort', '已取消'));
                return;
            }
            if (typeof signal.addEventListener === 'function') {
                state.onAbort = () => {
                    channel.error(appError('abort', '已取消'));
                    if (state.task && typeof state.task.abort === 'function') {
                        try {
                            state.task.abort();
                        } catch (error) {
                            // 忽略
                        }
                    }
                };
                signal.addEventListener('abort', state.onAbort);
            }
        }

        async function attempt(retried) {
            const token = await ensureToken(retried);
            // 解码器必须跨分块复用：一个中文字符 3 字节，被切在块边界时残留字节要留到下一块，
            // 每块新建解码器会直接把这些字节丢掉，表现为「番茄炒蛋」变成「番炒蛋」。
            const decoder = createUtf8Decoder();
            const sse = createSseParser((data) => {
                if (data === '[DONE]') {
                    channel.close();
                    return;
                }
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (error) {
                    return;
                }
                if (parsed && parsed.ok === false) {
                    channel.error(appError(parsed.code || 'UPSTREAM_ERROR', parsed.message || '模型调用失败'));
                    return;
                }
                const choice = parsed && parsed.choices ? parsed.choices[0] : null;
                if (!choice) return;
                const delta = choice.delta || {};
                const content = typeof delta.content === 'string' ? delta.content : '';
                if (content !== '') {
                    channel.push({ choices: [{ delta: { content: content }, finish_reason: choice.finish_reason || null }] });
                } else if (choice.finish_reason) {
                    channel.push({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] });
                }
            });

            const response = await rawRequest({
                url: serverUrl(config.CHAT_PATH),
                method: 'POST',
                data: payload,
                token: token,
                timeoutMs: src.timeoutMs,
                signal: src.signal,
                onTask: (task) => {
                    state.task = task;
                },
                onChunk: (data) => {
                    const text = typeof data === 'string' ? data : decoder(data);
                    if (text) sse.push(text);
                },
            });

            sse.flush();

            const status = (response && response.statusCode) || 0;

            if (status === 401 && !retried) {
                clearToken();
                await attempt(true);
                return;
            }
            if (status === 429) {
                channel.error(appError('RATE_LIMITED', '请求太频繁了，等一会儿再试'));
                return;
            }
            if (status !== 200) {
                const body = parseJsonBody(response);
                channel.error(appError(
                    (body && body.code) || 'UPSTREAM_ERROR',
                    (body && body.message) || ('转发服务返回 ' + status)
                ));
                return;
            }
            channel.close();
        }

        attach();
        attempt(false).catch((error) => {
            channel.error(error);
        });

        try {
            for await (const chunk of channel.iterator) {
                yield chunk;
            }
        } finally {
            detach();
        }
    })();
}

// ── newapi 通道：云函数（无流式）───────────────────────────────────────────

function invoke(task, input, options) {
    ensureCloud();
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) || Number(config.CLIENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const signal = opts.signal || null;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        function onAbort() {
            settle(reject, appError('abort', '已取消'));
        }

        function settle(fn, value) {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && typeof signal.removeEventListener === 'function') {
                try {
                    signal.removeEventListener('abort', onAbort);
                } catch (error) {
                    // 忽略
                }
            }
            fn(value);
        }

        if (signal) {
            if (signal.aborted) {
                settle(reject, appError('abort', '已取消'));
                return;
            }
            if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
        }

        timer = setTimeout(() => {
            settle(reject, appError('timeout', '模型响应超时，稍后再试'));
        }, timeoutMs);

        try {
            wxApi().cloud.callFunction({
                name: config.CLOUD_FUNCTION_NAME,
                data: Object.assign({ task: task }, input || {}),
                success: (response) => {
                    const result = response ? response.result : null;
                    if (!result) {
                        settle(reject, appError('BAD_RESPONSE', '云函数没有返回结果'));
                        return;
                    }
                    if (result.ok === true) {
                        settle(resolve, result);
                        return;
                    }
                    settle(reject, appError(result.code || 'UPSTREAM_ERROR', result.message || '自建模型没有返回内容'));
                },
                fail: (error) => {
                    settle(reject, mapCallError(error));
                },
            });
        } catch (error) {
            settle(reject, mapCallError(error));
        }
    });
}

// callFunction 层面的失败要和「模型自己出错」分开：前者多半是没部署 / 没开通，文案要能指导排查。
function mapCallError(error) {
    const message = (error && (error.errMsg || error.message)) || '云函数调用失败';
    const code = String((error && error.errCode) || '');
    if (code === '-504003' || /timeout|timed ?out|ESOCKETTIMEDOUT/i.test(message)) {
        return appError('timeout', '模型响应超时，稍后再试');
    }
    if (code === '-501000' || /FUNCTION_NOT_FOUND|function not found|ResourceNotFound/i.test(message)) {
        return appError('NO_FUNCTION', '云函数 ' + config.CLOUD_FUNCTION_NAME + ' 还没部署，先在开发者工具里上传并部署');
    }
    if (/env[^\n]{0,40}(not exist|invalid|not found)|invalid env/i.test(message)) {
        return appError('NO_CLOUD', '云开发环境没配好：检查 model-config.js 的 CLOUD_ENV');
    }
    return appError('PROXY_FAILED', message);
}

function createViaFunction(params) {
    const src = params || {};
    const task = src.task || 'recipe';
    const input = Object.assign({}, src.input || {});
    if (src.model) input.model = src.model;
    if (typeof src.temperature === 'number') input.temperature = src.temperature;

    return (async function* run() {
        const result = await invoke(task, input, {
            signal: src.signal,
            timeoutMs: src.timeoutMs,
        });
        const content = typeof result.content === 'string' ? result.content : '';
        if (typeof src.onProgress === 'function') src.onProgress(content.length);
        yield {
            model: result.model || input.model || '',
            choices: [
                {
                    delta: { content: content },
                    finish_reason: result.finishReason || 'stop',
                },
            ],
            usage: result.usage || null,
        };
    })();
}

// ── 模型列表 ───────────────────────────────────────────────────────────────

function normalizeModels(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map((item) => {
            if (!item) return null;
            const id = String(item.id || item.model || '').trim();
            if (id === '') return null;
            return {
                id: id,
                name: String(item.name || id),
                supportsImages: item.supportsImages === true,
                disabled: item.disabled === true,
                // 深度思考是服务端策略（server/llm-proxy.js 的 DEEP_THINKING），
                // 客户端只负责照实显示；字段缺失一律按关闭处理，不要自己猜成开启。
                thinkingEnabled: item.thinkingEnabled === true,
            };
        })
        .filter((item) => item !== null);
}

async function listModelsViaServer() {
    if (modelsCache && modelsCacheProvider === config.PROVIDER) return modelsCache;

    const response = await serverFetch(config.MODELS_PATH, { timeoutMs: MODELS_TIMEOUT_MS });
    const body = parseJsonBody(response);
    if (!body || body.ok !== true) {
        throw appError((body && body.code) || 'BAD_RESPONSE', (body && body.message) || '拿不到模型列表');
    }
    const models = normalizeModels(body.models);
    if (models.length === 0) return [];
    modelsCache = models;
    modelsCacheProvider = config.PROVIDER;
    return models;
}

async function listModelsViaFunction() {
    if (modelsCache && modelsCacheProvider === config.PROVIDER) return modelsCache;

    const result = await invoke('models', {}, { timeoutMs: MODELS_TIMEOUT_MS });
    const models = normalizeModels(result.models);
    // 空结果不缓存：多半是服务端配置还没填好，改完应该能立刻生效。
    if (models.length === 0) return [];
    modelsCache = models;
    modelsCacheProvider = config.PROVIDER;
    return models;
}

function listModels() {
    if (isServer()) return listModelsViaServer();
    if (isNewApi()) return listModelsViaFunction();
    const { cloud } = require('./cloud');
    return Promise.resolve(cloud.llm.models.list());
}

// ── create 分发 ────────────────────────────────────────────────────────────

// platform 通道只接受它认识的字段。params 里带的 task/input 是给自建通道用的，
// 原样透传可能被网关当成未知参数拒绝，所以这里做一次白名单拷贝。
function toPlatformParams(params) {
    const src = params || {};
    const out = {
        model: src.model,
        messages: src.messages,
        stream: src.stream !== false,
    };
    if (typeof src.temperature === 'number') out.temperature = src.temperature;
    if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
    if (src.response_format) out.response_format = src.response_format;
    if (src.signal) out.signal = src.signal;
    return out;
}

function create(params) {
    if (isServer()) return createViaServer(params);
    if (isNewApi()) return createViaFunction(params);
    const { cloud } = require('./cloud');
    return cloud.llm.chat.completions.create(toPlatformParams(params));
}

// ── Agent 通道（M5）────────────────────────────────────────────────────────
// 与 chat 的区别：chat 是「一次模型调用」，agent 是「服务端最多 5 轮工具循环」。
// 所以这里是一次普通 POST（不是 SSE），一次返回 {ok, answer, steps, truncated, model}。
//
// 为什么不在客户端跑 ReAct 循环：wx.request 硬上限 60s，多步必然超时；
// 而且工具要访问数据库，RLS 靠 JWT 的 sub 求值，客户端拿不到那个身份。
//
// 只在 PROVIDER='server' 下可用 —— 云函数通道和 platform 通道都没有工具执行能力。
function agent(payload) {
    if (!isServer()) {
        return Promise.reject(appError(
            'NO_AGENT',
            '当前模型通道不支持联网助手，请在设置里切到自建通道'
        ));
    }
    const src = payload || {};
    const text = String(src.text || '').trim();
    if (text === '') {
        return Promise.reject(appError('EMPTY', '说点什么吧'));
    }

    const data = { text: text.slice(0, 1000) };
    if (src.model) data.model = src.model;
    // 短期记忆：把前几轮纯文本对话带上去。
    // 只带 user / assistant 两条，不带工具调用细节（那是服务端执行过程，
    // 重放回去会让模型以为工具已经调过了）。
    if (Array.isArray(src.history) && src.history.length > 0) {
        data.history = src.history
            .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content)
            .slice(-10)
            .map((t) => ({ role: t.role, content: String(t.content).slice(0, 800) }));
    }

    return (async function run() {
        const response = await serverFetch(config.AGENT_PATH, {
            method: 'POST',
            data: data,
            // 服务端预算 50s，这里 58s：让服务端的收口消息先回来，
            // 而不是客户端先报 request:fail timeout（那样用户看不到任何结果）。
            timeoutMs: config.CLIENT_TIMEOUT_MS,
        });
        const body = parseJsonBody(response);
        if (!body || body.ok !== true) {
            throw appError(
                (body && body.code) || 'AGENT_FAILED',
                (body && body.message) || '助手这次没答上来，再试一次'
            );
        }
        return {
            answer: String(body.answer || ''),
            status: String(body.status || 'ok'),   // ok / degraded / truncated
            steps: Array.isArray(body.steps) ? body.steps.map((step) => ({
                tool: String(step && step.tool || ''),
                ok: !!(step && step.ok),
                retried: !!step && step.retried === true,
                elapsedMs: Number(step && step.elapsedMs) || 0,
                summary: String(step && step.summary || ''),
            })) : [],
            truncated: body.truncated === true,
            model: String(body.model || ''),
        };
    }());
}

module.exports = {
    models: { list: listModels },
    chat: { completions: { create: create } },
    agent: agent,
    ensureCloud: ensureCloud,
    isServer: isServer,
    isNewApi: isNewApi,
    isPlatform: isPlatform,
    clearToken: clearToken,
    PROVIDER: config.PROVIDER,
};
