# 生产部署状态（2026-10-22，阿里云 SERVER_IP）

## 当前生产

- 域名：`https://touhaobiao.cn`、`https://www.touhaobiao.cn`
- 公网 IP：`SERVER_IP`（阿里云）
- 系统：Alibaba Cloud Linux 3（OpenAnolis Edition），2 核 / 3.5GB
- 应用目录：`/opt/touhaobiao`
- 进程：PM2 `touhaobiao`，单实例 `fork`
- 数据库：PostgreSQL 13.23，本机 `127.0.0.1:5432`，库名 `touhaobiao`
- Nginx：宝塔面板自带 Nginx（`/www/server/nginx`），独立 vhost：
  `/www/server/panel/vhost/nginx/touhaobiao.cn.conf`
- HTTPS：Let's Encrypt，覆盖 `touhaobiao.cn` 和 `www.touhaobiao.cn`，到期 2027-01-20
- 健康检查：`/api/health` 返回 `{"status":"ok","db":"ok"}`

## 已有站点

服务器上原有站点（如 `kf01.usaedu.net`、`aibot.usaedu.net`、`app.api.mentorspark.com`）保持原状，
本次只新增 `touhaobiao.cn` 的独立 Nginx vhost，未覆盖其他站点配置。

## 数据

从旧生产 `OLD_SERVER_IP` 迁移：

- 数据库快照：仅 `admin` 账号（`mustChangePassword=true`），0 项目、0 订单
- `data` 目录：44KB
- 管理员密码文件：`ADMIN_PASSWORD_FILE`（600）

如果本地开发库中还有真实用户/项目数据，需要另行迁移；当前旧生产库本身没有这些数据。

## 备份

- 脚本：`/opt/touhaobiao/backup.sh`
- Cron：`/etc/cron.d/touhaobiao-backup`，每天 03:15
- 备份目录：`/opt/touhaobiao/backups`，保留 14 天
- 已验证手工执行成功

## 支付

- `PAYMENT_ENABLED=0`（尚未开启真实支付）
- 支付宝/微信密钥已从旧服务器迁移到 `/opt/touhaobiao/secrets`
- 支付宝需把新 IP `SERVER_IP` 加入服务器 IP 白名单
- 微信仍需解决 `APPID_MCHID_NOT_MATCH`（AppID 未绑定商户号）
- 支付回调域名不变：`/api/payment/alipay/notify`、`/api/payment/wechat/notify`

## 尚未完成/需业务确认

- 短信服务未配置（`SMS_PROVIDER` 为空），普通用户短信登录不可用，管理员密码登录可用
- 域名 ICP 接入备案状态需在阿里云侧确认
- 服务器原有 MySQL/Redis/宝塔面板等端口对外监听，建议按运维规范收紧安全组
- 旧服务器 `OLD_SERVER_IP` 仍保留，可作回滚
