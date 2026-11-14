#!/usr/bin/env bash
# 步骤 5：把 pg / pgrst / llm-proxy 三个手工 docker run 的容器收编成一个 compose 栈
#
# 做了什么：
#   1. 从现网 llm-proxy 容器导出非密钥 env → /root/cloud/app.env（600）
#   2. 把缺的密钥补进 /root/cloud-secrets.env（600，已存在就不动）
#   3. 逻辑备份数据库到 /root/backups/
#   4. docker compose config 校验
#   5. 停并删旧容器 → compose up -d（数据在 /root/pg/data bind mount，不受影响）
#   6. 验证：容器状态、行数、健康端点
#
# 幂等：可重复执行；已是 compose 栈时只会 reconcile。
set -euo pipefail

COMPOSE=/root/cloud/docker-compose.yml
APP_ENV=/root/cloud/app.env
SECRETS=/root/cloud-secrets.env
STAMP=$(date -u +%Y%m%d-%H%M%S)

mkdir -p /root/cloud /root/backups
umask 077

echo "== 1/6 导出非密钥 env =="
/usr/bin/node - <<'JS'
const { execFileSync } = require('child_process');
const fs = require('fs');
const env = JSON.parse(execFileSync('docker', ['inspect', '-f', '{{json .Config.Env}}', 'llm-proxy'], { encoding: 'utf8' }));
const SECRET_KEYS = new Set(['NEWAPI_KEY', 'LLM_TOKEN_SECRET', 'WX_SECRET', 'CLOUD_JWT_SECRET', 'CLOUD_PUBLISHABLE_KEY', 'PG_AUTH_PASS']);
const SKIP = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOSTNAME', 'HOME']);
const out = [];
for (const e of env) {
    const i = e.indexOf('=');
    const k = e.slice(0, i);
    const v = e.slice(i + 1);
    if (SKIP.has(k)) continue;
    if (SECRET_KEYS.has(k)) {
        // 密钥：只补进 secrets 文件，不写 app.env
        continue;
    }
    out.push(`${k}=${v}`);
}
// 网关必需但可能不在旧 env 里的默认值
const defaults = {
    LLM_PORT: '8788',
    LLM_HOST: '0.0.0.0',
    PGRST_URL: 'http://pgrst:3000',
    CLOUD_DB_ROLE: 'authenticated',
    CLOUD_ACCESS_TOKEN_TTL: '7200',
    CLOUD_REFRESH_TOKEN_TTL: '2592000',
};
const have = new Set(out.map((l) => l.slice(0, l.indexOf('='))));
for (const [k, v] of Object.entries(defaults)) if (!have.has(k)) out.push(`${k}=${v}`);
fs.writeFileSync('/root/cloud/app.env', out.join('\n') + '\n', { mode: 0o600 });
console.log(`  app.env 写入 ${out.length} 项`);

// 密钥补充（值从现网容器读，保证与线上一致）
const secretsPath = '/root/cloud-secrets.env';
let cur = fs.readFileSync(secretsPath, 'utf8');
const want = {};
for (const e of env) {
    const i = e.indexOf('=');
    const k = e.slice(0, i);
    if (SECRET_KEYS.has(k)) want[k] = e.slice(i + 1);
}
let added = 0;
for (const [k, v] of Object.entries(want)) {
    const re = new RegExp('^' + k + '=', 'm');
    if (!re.test(cur)) {
        if (!cur.endsWith('\n')) cur += '\n';
        cur += `${k}=${v}\n`;
        added += 1;
    }
}
fs.writeFileSync(secretsPath, cur, { mode: 0o600 });
console.log(`  cloud-secrets.env 补入 ${added} 项`);
JS
chmod 600 "$APP_ENV" "$SECRETS"
# compose 在项目目录读 .env 做插值，symlink 保证只有一份密钥来源
ln -sf "$SECRETS" /root/cloud/.env

echo "== 2/6 校验 compose 配置 =="
docker compose -f "$COMPOSE" config -q && echo "  config OK"

echo "== 3/6 逻辑备份 =="
if docker inspect pg >/dev/null 2>&1; then
    docker exec pg pg_dump -U postgres -Fc -d postgres > "/root/backups/pre-compose-$STAMP.dump"
    ls -lh "/root/backups/pre-compose-$STAMP.dump" | awk '{print "  "$9" "$5}'
else
    echo "  pg 不存在，跳过"
fi

echo "== 4/6 移交给 compose =="
for c in llm-proxy pgrst pg; do docker rm -f "$c" >/dev/null 2>&1 || true; done

echo "== 5/6 启动 =="
docker compose -f "$COMPOSE" up -d
for i in $(seq 1 40); do
    docker exec pg pg_isready -U postgres -q 2>/dev/null && break
    sleep 1
done

echo "== 6/6 验证 =="
docker compose -f "$COMPOSE" ps
echo "-- 行数 --"
docker exec pg psql -U postgres -d postgres -Atc \
  "select 'spaces='||(select count(*) from public.couple_space)||' members='||(select count(*) from public.couple_member)||' ingredients='||(select count(*) from public.ingredient)||' notify='||(select count(*) from public.notify_setting)"
echo "-- 健康端点（容器网内） --"
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' llm-proxy)
for p in /llm/healthz /.cloud/healthz; do
    printf '  %-18s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://$IP:8787$p")"
done
echo "-- 资源 --"
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" pg pgrst llm-proxy
free -m | sed -n 2p