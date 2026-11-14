#!/usr/bin/env bash
# 步骤 4：把临期提醒 cron 接到自建库，并恢复 crontab
#   1) 把 reminder 令牌的 sha256 写进数据库级 GUC（函数里比对用）
#   2) reminder.env 的 WB_ENDPOINT / WB_ANON_KEY 换成自建网关
#   3) 重启 pgrst（连接池拿到新的 db 级 setting）
#   4) 去掉 crontab 里的 #DISABLED
#   5) DRY_RUN 空跑一次，确认真实链路通
set -euo pipefail

# 对外域名由调用方提供，不要写死（这个脚本会开源）。
# 用法：PUBLIC_BASE=https://your-domain.example.com bash step4-reminder-cron.sh
PUBLIC_BASE="${PUBLIC_BASE:?请先设置 PUBLIC_BASE，例如 PUBLIC_BASE=https://your-domain.example.com}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

echo "== 1/5 令牌哈希入库 =="
set -a; . /opt/reminder/reminder.env; set +a
H=$(printf '%s' "$REMINDER_TOKEN" | sha256sum | awk '{print $1}')
docker exec pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -c "alter database postgres set app.reminder_token_sha256 = '$H';"
docker exec pg psql -U postgres -d postgres -Atc \
    "select 'db 级 GUC = ' || coalesce(current_setting('app.reminder_token_sha256', true), '(空)');"

echo "== 2/5 更新 reminder.env =="
cp -a /opt/reminder/reminder.env "/opt/reminder/reminder.env.bak.$(date +%s)"
set -a; . /root/cloud-secrets.env; set +a
sed -i "s|^WB_ENDPOINT=.*|WB_ENDPOINT=${PUBLIC_BASE}|" /opt/reminder/reminder.env
sed -i "s|^WB_ANON_KEY=.*|WB_ANON_KEY=${CLOUD_PUBLISHABLE_KEY}|" /opt/reminder/reminder.env
chmod 600 /opt/reminder/reminder.env
grep -E '^WB_ENDPOINT=' /opt/reminder/reminder.env
grep -c . /opt/reminder/reminder.env

echo "== 3/5 重启 pgrst =="
docker restart pgrst >/dev/null
sleep 3
docker ps --filter name=pgrst --format '{{.Names}} {{.Status}}'

echo "== 4/5 恢复 crontab =="
crontab -l | sed 's/^#DISABLED //' | crontab -
crontab -l | grep -i reminder || true

echo "== 5/5 DRY_RUN 空跑 =="
cd /opt/reminder && DRY_RUN=1 node reminder-cron.js 2>&1 | tail -25