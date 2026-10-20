#!/usr/bin/env bash
# 投好标生产恢复脚本（危险操作，先停服务并确认已有当前备份）。
# 用法：
#   DATABASE_URL='postgresql://...' YIBIAO_DATA_DIR='/opt/openbidkit-yibiao-web/data' \
#     DB_DUMP='/opt/openbidkit-yibiao-web/backups/db-YYYYmmdd-HHMMSS.dump' \
#     DATA_TAR='/opt/openbidkit-yibiao-web/backups/data-YYYYmmdd-HHMMSS.tar.gz' \
#     ./deploy/backup/restore.sh
set -euo pipefail

: "${DATABASE_URL:?必须设置 DATABASE_URL}"
: "${YIBIAO_DATA_DIR:?必须设置 YIBIAO_DATA_DIR}"
: "${DB_DUMP:?必须设置 DB_DUMP（pg_dump custom 格式）}"
: "${DATA_TAR:?必须设置 DATA_TAR（data-*.tar.gz）}"

DATA_DIR="$(cd "$YIBIAO_DATA_DIR" && pwd)"
DATA_PARENT="$(dirname "$DATA_DIR")"
DATA_NAME="$(basename "$DATA_DIR")"

echo "即将用以下备份覆盖当前数据："
echo "  DB:   $DB_DUMP -> $DATABASE_URL"
echo "  DATA: $DATA_TAR -> $DATA_DIR"
read -r -p "确认继续请输入 RESTORE： " answer
[ "$answer" = "RESTORE" ] || { echo "已取消"; exit 1; }

test -s "$DB_DUMP"
test -s "$DATA_TAR"

echo "[restore] 恢复数据库（会清理同名对象）"
pg_restore "$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$DB_DUMP"

echo "[restore] 恢复数据目录（先备份当前目录为 .pre-restore）"
if [ -d "$DATA_DIR" ]; then
  mv "$DATA_DIR" "$DATA_DIR.pre-restore-$(date +%Y%m%d-%H%M%S)"
fi
tar -C "$DATA_PARENT" -xzf "$DATA_TAR"

echo "[restore] 完成。请启动服务并验证 GET /api/health、登录、项目列表与导出。"
