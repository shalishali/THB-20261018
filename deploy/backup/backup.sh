#!/usr/bin/env bash
# 投好标生产备份脚本：PostgreSQL 逻辑备份 + 运行数据目录打包。
# 用法（建议 cron 每日 02:00，并在发布前手动执行一次）：
#   DATABASE_URL='postgresql://...' YIBIAO_DATA_DIR='/opt/openbidkit-yibiao-web/data' \
#     BACKUP_DIR='/opt/openbidkit-yibiao-web/backups' ./deploy/backup/backup.sh
set -euo pipefail

: "${DATABASE_URL:?必须设置 DATABASE_URL}"
: "${YIBIAO_DATA_DIR:?必须设置 YIBIAO_DATA_DIR}"
BACKUP_DIR="${BACKUP_DIR:-/opt/openbidkit-yibiao-web/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

umask 077
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
DATA_DIR="$(cd "$YIBIAO_DATA_DIR" && pwd)"
DATA_PARENT="$(dirname "$DATA_DIR")"
DATA_NAME="$(basename "$DATA_DIR")"

echo "[backup] database -> $BACKUP_DIR/db-$STAMP.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$BACKUP_DIR/db-$STAMP.dump"

echo "[backup] data dir -> $BACKUP_DIR/data-$STAMP.tar.gz"
tar -C "$DATA_PARENT" -czf "$BACKUP_DIR/data-$STAMP.tar.gz" "$DATA_NAME"

# 校验产物非空（备份失败最常见原因是权限/磁盘满）
test -s "$BACKUP_DIR/db-$STAMP.dump"
test -s "$BACKUP_DIR/data-$STAMP.tar.gz"
echo "[backup] done: db-$STAMP.dump, data-$STAMP.tar.gz"

# 清理过期备份
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'data-*.tar.gz' \) -mtime +"$RETENTION_DAYS" -print -delete

cat <<'EOF'
[backup] 建议：
  1. 将备份同步到独立存储/异地并加密（备份含客户标书与联系方式）；
  2. 每季度至少做一次恢复演练：停服务 → 恢复数据库 → 解压数据目录 → 启动并验证 /api/health；
  3. 不要把备份放在 Web 可访问目录或 Git 工作区。
EOF
