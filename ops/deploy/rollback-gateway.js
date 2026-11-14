'use strict';
/**
 * rollback-gateway.js —— 把 llm-proxy 容器还原成 last-container.json 记录的原样
 * 用法：node rollback-gateway.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const DIR = '/root/llm-proxy';
const cfg = JSON.parse(fs.readFileSync(`${DIR}/last-container.json`, 'utf8'));

const args = [
    'run', '-d', '--name', 'llm-proxy', '--restart', 'always',
    '--network', cfg.HostConfig.NetworkMode || 'app_net',
    '--user', cfg.Config.User || '1000:1000',
    '--memory', String(cfg.HostConfig.Memory || 201326592),
    '--memory-swap', String(cfg.HostConfig.MemorySwap || 335544320),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
];
for (const m of cfg.Mounts) args.push('-v', `${m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`);
for (const e of cfg.Config.Env) {
    if (/^(PATH|NODE_VERSION|YARN_VERSION|HOSTNAME|HOME)=/.test(e)) continue;
    args.push('--env', e);
}
args.push(cfg.Config.Image, ...(cfg.Config.Cmd || ['node', '/app/llm-proxy.js']));

try { execFileSync('docker', ['rm', '-f', 'llm-proxy'], { stdio: 'ignore' }); } catch (_) {}
const id = execFileSync('docker', args, { encoding: 'utf8' }).trim();
console.log('rolled back llm-proxy', id.slice(0, 12));
console.log(execFileSync('docker', ['logs', '--tail', '15', 'llm-proxy'], { encoding: 'utf8' }));