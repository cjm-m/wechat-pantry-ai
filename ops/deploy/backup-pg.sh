#!/usr/bin/env bash
# 每日 Postgres 备份 + 轮转。
#
# 为什么需要：watchdog.js 只做「容器挂了自动拉起」，救不了这几种情况——
#   * 误执行 SQL 删了表/改错数据
#   * 磁盘写坏、文件系统损坏
#   * 误删数据库
# 这些只有备份能救。
#
# 部署：
#   scp ops/deploy/backup-pg.sh root@<host>:/root/cloud/backup-pg.sh
#   ssh root@<host> 'chmod 700 /root/cloud/backup-pg.sh && echo "17 3 * * * /root/cloud/backup-pg.sh >> /var/log/pg-backup.log 2>&1" | crontab -'
#
# 设计取舍：
#   * 用 pg_dump -Fc（自定义格式）：单文件、可选择性恢复、自带压缩
#   * 轮转按天保留：7 份日备 + 每月 1 份（当月最后一天跑的那份），够两个人用一年
#   * 备份完立刻验证：pg_restore --list 能读出目录才算成功。
#     只写文件不验证 = 备份可能是空的，出事时才发现
#   * 不传远端（这台机器没装 rclone/aws），异地备份是独立一件事，
#     异地备份是独立的一件事，需要先决定去哪（R2 / 另一台机器）
set -euo pipefail

DB=${BACKUP_DB:-postgres}
OUT_DIR=${BACKUP_DIR:-/root/db-backups}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_MONTHLY=${BACKUP_KEEP_MONTHLY:-12}

STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)
MONTH=$(date +%Y%m)

mkdir -p "$OUT_DIR/daily" "$OUT_DIR/monthly"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

fail() {
    log "FAIL $*"
    exit 1
}

# ── 1. 导出 ────────────────────────────────────────────────────────────────
TMP="$OUT_DIR/daily/.tmp-$STAMP.dump"
TARGET="$OUT_DIR/daily/pg-$STAMP.dump"

log "开始备份 db=$DB -> $TARGET"

# 先写临时文件再 mv：中途失败不会留下半个文件冒充有效备份
if ! docker exec pg pg_dump -U postgres -d "$DB" -Fc > "$TMP" 2>"$OUT_DIR/daily/.err-$STAMP.txt"; then
    log "pg_dump 失败，错误："
    cat "$OUT_DIR/daily/.err-$STAMP.txt" >&2 || true
    rm -f "$TMP" "$OUT_DIR/daily/.err-$STAMP.txt"
    fail "pg_dump 返回非零"
fi

SIZE=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 1024 ]; then
    rm -f "$TMP" "$OUT_DIR/daily/.err-$STAMP.txt"
    fail "产物只有 $SIZE 字节，明显不对（正常至少几十 KB）"
fi

# ── 2. 验证 ────────────────────────────────────────────────────────────────
# 只写不验 = 备份可能是个空壳。这里必须能列出目录结构，且包含表数据条目。
if ! docker exec -i pg pg_restore -l < "$TMP" > "$OUT_DIR/daily/.list-$STAMP.txt" 2>/dev/null; then
    rm -f "$TMP" "$OUT_DIR/daily/.err-$STAMP.txt" "$OUT_DIR/daily/.list-$STAMP.txt"
    fail "pg_restore --list 读不出目录，备份文件已损坏"
fi

TABLE_DATA=$(grep -c 'TABLE DATA' "$OUT_DIR/daily/.list-$STAMP.txt" || true)
if [ "$TABLE_DATA" -lt 1 ]; then
    rm -f "$TMP" "$OUT_DIR/daily/.err-$STAMP.txt" "$OUT_DIR/daily/.list-$STAMP.txt"
    fail "备份里一个 TABLE DATA 条目都没有，等于备份了个空库"
fi

mv "$TMP" "$TARGET"
rm -f "$OUT_DIR/daily/.err-$STAMP.txt" "$OUT_DIR/daily/.list-$STAMP.txt"

log "备份成功 size=$SIZE bytes tables_with_data=$TABLE_DATA"

# ── 3. 月度副本 ────────────────────────────────────────────────────────────
# 每月 1 号（跑当天第一次时）留一份长期副本，防止「坏数据被 7 份日备滚掉」
if [ "$(date +%d)" = "01" ]; then
    cp -a "$TARGET" "$OUT_DIR/monthly/pg-$MONTH.dump"
    log "已留月度副本 pg-$MONTH.dump"
fi

# ── 4. 轮转 ────────────────────────────────────────────────────────────────
# daily: 按文件名排序后删掉最老的（文件名带时间戳，字典序 = 时间序）
DAILY_COUNT=$(find "$OUT_DIR/daily" -name 'pg-*.dump' -type f | wc -l)
if [ "$DAILY_COUNT" -gt "$KEEP_DAILY" ]; then
    find "$OUT_DIR/daily" -name 'pg-*.dump' -type f | sort | head -n "$((DAILY_COUNT - KEEP_DAILY))" | while read -r old; do
        rm -f "$old"
        log "轮转删除 $(basename "$old")"
    done
fi

MONTHLY_COUNT=$(find "$OUT_DIR/monthly" -name 'pg-*.dump' -type f | wc -l)
if [ "$MONTHLY_COUNT" -gt "$KEEP_MONTHLY" ]; then
    find "$OUT_DIR/monthly" -name 'pg-*.dump' -type f | sort | head -n "$((MONTHLY_COUNT - KEEP_MONTHLY))" | while read -r old; do
        rm -f "$old"
        log "轮转删除月度 $(basename "$old")"
    done
fi

# ── 5. 磁盘水位告警 ────────────────────────────────────────────────────────
# 磁盘满会让 pg 挂掉（PG 写不了 WAL 就直接拒绝服务），比备份丢失更急
USE_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$USE_PCT" -ge 88 ]; then
    log "WARN 磁盘使用 ${USE_PCT}%，已超过 88%，请清理"
fi

log "完成。日备 $(find "$OUT_DIR/daily" -name 'pg-*.dump' | wc -l) 份，月备 $(find "$OUT_DIR/monthly" -name 'pg-*.dump' | wc -l) 份，占用 $(du -sh "$OUT_DIR" | cut -f1)"
