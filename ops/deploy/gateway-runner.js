'use strict';
/**
 * gateway-runner.js —— 用「现网 llm-proxy 容器的真实配置」重建一个跑 cloud-gateway.js 的容器
 *
 * 为什么不用 --env-file：NEWAPI_MODELS 这个变量的值里带换行符，
 * 写进 env-file 会被拆成多行、docker 解析失败；必须用 argv 逐个 --env 传。
 * 又因为同样的换行问题，`docker inspect --format` + bash 数组也不可靠，
 * 所以这里用 Node 直接吃 JSON，再 spawn。
 *
 * 用法：
 *   node gateway-runner.js test     起一个叫 gw-check 的一次性容器（不影响线上）
 *   node gateway-runner.js swap     rm -f llm-proxy 后用 gateway 重建（线上切换）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const DIR = '/root/llm-proxy';
const mode = process.argv[2] || 'test';
const target = mode === 'swap' ? 'llm-proxy' : 'gw-check';
const cmd = mode === 'swap' ? ['node', '/app/cloud-gateway.js'] : ['node', '/app/cloud-gateway.js'];

function inspect(name) {
    return JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
}
function sh(args, opts) {
    try { return execFileSync('docker', args, Object.assign({ encoding: 'utf8' }, opts)); }
    catch (e) { return e; }
}

const cfg = inspect('llm-proxy');
fs.writeFileSync(`${DIR}/last-container.json`, JSON.stringify(cfg, null, 2));

const skip = /^(PATH|NODE_VERSION|YARN_VERSION|HOSTNAME|HOME|LLM_PORT)=/;
const envs = cfg.Config.Env.filter((e) => !skip.test(e));

const secrets = {};
for (const line of fs.readFileSync('/root/cloud-secrets.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) secrets[m[1]] = m[2];
}
const extra = [
    'LLM_PORT=8788',                                  // llm-proxy 让出 8787
    `CLOUD_JWT_SECRET=${secrets.CLOUD_JWT_SECRET}`,
    `CLOUD_PUBLISHABLE_KEY=${secrets.CLOUD_PUBLISHABLE_KEY}`,
    'PGRST_URL=http://pgrst:3000',
    'CLOUD_DB_ROLE=authenticated',
    'CLOUD_ACCESS_TOKEN_TTL=7200',
    'CLOUD_REFRESH_TOKEN_TTL=2592000',
];

const args = [
    'run', '-d', '--name', target,
    '--restart', mode === 'swap' ? 'always' : 'no',
    '--network', 'app_net',
    '--user', '1000:1000',
    '--memory', String(cfg.HostConfig.Memory || 201326592),
    '--memory-swap', String(cfg.HostConfig.MemorySwap || 335544320),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
];
for (const m of cfg.Mounts) args.push('-v', `${m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`);
args.push('-v', `${DIR}/cloud-gateway.js:/app/cloud-gateway.js:ro`);
for (const e of envs) args.push('--env', e);
for (const e of extra) args.push('--env', e);
args.push(cfg.Config.Image, ...cmd);

console.log('removing old', target);
sh(['rm', '-f', target], { stdio: 'ignore' });
const id = sh(args);
if (typeof id !== 'string') {
    console.error('docker run 失败：');
    console.error(String(id.stderr || id.message));
    process.exit(1);
}
console.log(`started ${target} ${id.trim().slice(0, 12)}`);