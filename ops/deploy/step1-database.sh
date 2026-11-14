#!/usr/bin/env bash
# 步骤 1：起真实 Postgres + 灌 schema + 建 PostgREST 用的 authenticator 角色
# 幂等：可重复执行；密钥只生成一次，落在 /root/cloud-secrets.env (600)
set -euo pipefail

SECRETS=/root/cloud-secrets.env
SCHEMA_SRC=${1:-/tmp/schema-rebuild.sql}

umask 077
touch "$SECRETS"; chmod 600 "$SECRETS"
add_secret() { # name value-prefix
    grep -q "^$1=" "$SECRETS" || echo "$1=$2" >> "$SECRETS"
}
add_secret CLOUD_JWT_SECRET        "$(openssl rand -hex 32)"
add_secret CLOUD_PUBLISHABLE_KEY   "wbpk_$(openssl rand -hex 32)"
add_secret PG_AUTH_PASS            "$(openssl rand -hex 24)"
set -a; . "$SECRETS"; set +a

echo "== 1/4 数据目录 =="
mkdir -p /root/pg/data
chown 999:999 /root/pg/data
chmod 700 /root/pg/data
df -h / | tail -1

echo "== 2/4 启动 postgres =="
docker rm -f pg >/dev/null 2>&1 || true
docker run -d --name pg --restart always --network app_net \
    --user 999:999 --memory 320m --memory-swap 448m \
    --cap-drop ALL --security-opt no-new-privileges \
    -e POSTGRES_PASSWORD="$PG_AUTH_PASS" \
    -e POSTGRES_INITDB_ARGS="--data-checksums" \
    -v /root/pg/data:/var/lib/postgresql/data \
    postgres:16-alpine \
    -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB \
    -c maintenance_work_mem=16MB -c effective_cache_size=96MB \
    -c timezone=UTC -c log_min_duration_statement=2000 >/dev/null

for i in $(seq 1 40); do
    docker exec pg pg_isready -U postgres -q && break
    sleep 1
done
docker exec pg pg_isready -U postgres || { echo "PG 没起来"; docker logs --tail 30 pg; exit 1; }

echo "== 3/4 灌 schema =="
docker cp "$SCHEMA_SRC" pg:/tmp/schema.sql
docker exec pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql
echo "schema OK"

echo "== 4/4 authenticator 角色 =="
docker exec -i pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v pass="$PG_AUTH_PASS" <<'SQL'
select format('create role authenticator login noinherit password %L', :'pass')
 where not exists (select 1 from pg_roles where rolname = 'authenticator') \gexec
select format('alter role authenticator with login noinherit password %L', :'pass') \gexec
grant anon, authenticated, service_role to authenticator;
select rolname, rolcanlogin, rolinherit from pg_roles
 where rolname in ('anon','authenticated','service_role','authenticator') order by 1;
SQL

echo "== 常驻内存 =="
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" pg
free -m | head -2