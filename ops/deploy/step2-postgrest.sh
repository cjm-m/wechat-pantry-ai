#!/usr/bin/env bash
# 步骤 2：起 PostgREST（对外只暴露容器网内 3000，不发布宿主端口）
set -euo pipefail

SECRETS=/root/cloud-secrets.env
set -a; . "$SECRETS"; set +a
: "${CLOUD_JWT_SECRET:?CLOUD_JWT_SECRET 缺失}"
: "${PG_AUTH_PASS:?PG_AUTH_PASS 缺失}"

echo "== 启动 postgrest =="
docker rm -f pgrst >/dev/null 2>&1 || true
docker run -d --name pgrst --restart always --network app_net \
    --memory 96m --memory-swap 128m \
    --cap-drop ALL --security-opt no-new-privileges \
    -e PGRST_DB_URI="postgres://authenticator:${PG_AUTH_PASS}@pg:5432/postgres" \
    -e PGRST_DB_SCHEMAS=public \
    -e PGRST_DB_ANON_ROLE=anon \
    -e PGRST_JWT_SECRET="$CLOUD_JWT_SECRET" \
    -e PGRST_SERVER_PORT=3000 \
    -e PGRST_LOG_LEVEL=info \
    postgrest/postgrest:latest >/dev/null

IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pgrst)
echo "pgrst 容器 IP: $IP"
for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://$IP:3000/" || true)
    [ "$code" = "200" ] && break
    sleep 1
done
echo "GET /           -> $code"

echo "== 匿名访问受保护表（应为空数组/401，绝不能有数据） =="
for t in couple_space couple_member ingredient shopping_item reminder_job; do
    body=$(curl -s -H 'Accept: application/json' "http://$IP:3000/$t" | head -c 120)
    printf '  %-16s %s\n' "$t" "$body"
done

echo "== 用真 JWT 验一条 =="
node -e '
const crypto = require("crypto");
const s = process.env.CLOUD_JWT_SECRET;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b64({ alg: "HS256", typ: "JWT" });
const p = b64({ sub: "wx:deploy_probe", role: "authenticated", exp: Math.floor(Date.now()/1000) + 300 });
const sig = crypto.createHmac("sha256", s).update(h + "." + p).digest("base64url");
console.log(h + "." + p + "." + sig);
' > /tmp/probe.jwt
JWT=$(cat /tmp/probe.jwt)
code=$(curl -s -o /tmp/probe.out -w '%{http_code}' -H "Authorization: Bearer $JWT" \
       -H 'Accept: application/json' "http://$IP:3000/couple_member")
echo "  couple_member(JWT wx:deploy_probe) -> $code  body=$(head -c 120 /tmp/probe.out)"

echo "== 详情 =="
docker ps --filter name=pgrst --format '{{.Names}}\t{{.Status}}'
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" pg pgrst
free -m | head -2