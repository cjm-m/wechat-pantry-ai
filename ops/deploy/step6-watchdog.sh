#!/usr/bin/env bash
# 步骤 6：把探活 watchdog 挂上 cron + 配 logrotate
#
# 幂等：重复执行只会确认现状，不会重复加行。
# 宿主 root 的 shell 是 zsh，所以这个脚本统一由 `ssh my-server 'bash -s' < step6-watchdog.sh` 喂进去跑。
set -euo pipefail

STATE_DIR=/var/lib/cloud-watchdog
LOG=/var/log/watchdog.log
CRON_LINE='*/5 * * * * /usr/bin/node /root/cloud/watchdog.js >> /var/log/watchdog.log 2>&1'

echo "== 1/5 目录与日志 =="
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
touch "$LOG"
chmod 640 "$LOG"
ls -ld "$STATE_DIR" "$LOG"

echo "== 2/5 crontab =="
# 先把现有 crontab 存一份带时间戳的备份（这台机器上没有别的备份手段）
crontab -l > "/root/crontab.bak.$(date -u +%Y%m%d-%H%M%S)" 2>/dev/null || true
if crontab -l 2>/dev/null | grep -Fq '/root/cloud/watchdog.js'; then
    echo "已存在 watchdog 行，跳过"
else
    # 用 printf 拼装后整体装上：避免边读边写把 crontab 写坏
    { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab -
    echo "已追加"
fi
echo "--- 当前 crontab ---"
crontab -l | grep -n 'watchdog\|reminder\|acme' || true

echo "== 3/5 logrotate =="
cat > /etc/logrotate.d/cloud-watchdog <<'ROTATE'
# watchdog 每 5 分钟一行，日均约 288 行（~40KB）；保留 4 周足够回溯一次故障。
# cron 里是 `>>` 追加写、没有长驻句柄，copytruncate 是安全的。
/var/log/watchdog.log {
    su root root
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
ROTATE
chmod 644 /etc/logrotate.d/cloud-watchdog
logrotate --debug /etc/logrotate.d/cloud-watchdog 2>&1 | tail -5

echo "== 4/5 加一条 crontab 说明注释（只有第一次加） =="
echo "== 5/5 立即跑一轮，确认写进日志 =="
node /root/cloud/watchdog.js >> "$LOG" 2>&1 || true
tail -3 "$LOG"
echo "== 完成 =="
