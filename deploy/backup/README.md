# 备份与恢复

生产必须同时备份 **PostgreSQL** 与 `YIBIAO_DATA_DIR`（上传的招标文件、生成的工作区、导出中间文件）。二者缺一不可。

## 备份

```bash
cd /opt/openbidkit-yibiao-web
export DATABASE_URL='postgresql://yibiao:***@127.0.0.1:5432/yibiao_web'
export YIBIAO_DATA_DIR='/opt/openbidkit-yibiao-web/data'
export BACKUP_DIR='/opt/openbidkit-yibiao-web/backups'
./deploy/backup/backup.sh
```

建议 cron（每日 02:00，保留 14 天）：

```cron
0 2 * * * cd /opt/openbidkit-yibiao-web && DATABASE_URL=... YIBIAO_DATA_DIR=... BACKUP_DIR=... RETENTION_DAYS=14 ./deploy/backup/backup.sh >> /var/log/yibiao-backup.log 2>&1
```

发布前、`db:push` 前、批量删除用户/项目前应额外手动执行一次。

## 恢复演练

```bash
# 1. 停服务（PM2）
pm2 stop openbidkit-yibiao-web
# 2. 恢复（脚本会二次确认）
DATABASE_URL=... YIBIAO_DATA_DIR=... DB_DUMP=... DATA_TAR=... ./deploy/backup/restore.sh
# 3. 启动并验证
pm2 start openbidkit-yibiao-web
curl -fsS https://你的域名/api/health
```

恢复后至少验证：健康检查、手机号登录、项目列表、打开一个已完成项目、导出 Word。

## 安全要求

- 备份含客户标书、联系方式与导出文档，**必须加密后异地保存**，权限 `600`，不得放在 Web 根目录或 Git 工作区。
- 定期校验 `pg_restore --list` 与 tar 可读性；至少每季度做一次完整恢复演练。
- 数据库备份与数据目录应尽量同一时间点生成，恢复后二者版本需一致。
