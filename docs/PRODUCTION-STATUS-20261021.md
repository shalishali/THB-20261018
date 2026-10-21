# 生产部署状态（2026-10-21）

## 服务器

- 域名：`touhaobiao.cn` / `www.touhaobiao.cn`
- 公网 IP：`OLD_SERVER_IP`（百度智能云；DNS 已指向该 IP）
- 系统：Ubuntu 24.04.1 LTS，2 vCPU / 1.9GB RAM / 40GB 磁盘
- 已加 2GB swap（`/swapfile`），时区 `Asia/Shanghai`
- 已安装：Node.js 24、pnpm、PM2、PostgreSQL、Nginx、LibreOffice、certbot

## 部署路径

| 内容 | 路径 |
| --- | --- |
| 项目 | `/opt/touhaobiao` |
| 后端源码 | `/opt/touhaobiao/server` |
| 前端 dist | `/opt/touhaobiao/client/dist` |
| 生产 env | `/opt/touhaobiao/server/.env`（600） |
| 数据目录 | `/opt/touhaobiao/data`（700） |
| 备份目录 | `/opt/touhaobiao/backups`（700） |
| 日志 | `/opt/touhaobiao/logs` |
| PM2 名称 | `touhaobiao`（fork，单实例） |
| Nginx 站点 | `/etc/nginx/sites-available/touhaobiao.cn` |
| TLS 证书 | `/etc/letsencrypt/live/touhaobiao.cn/` |

## 已完成验证

- PM2 `touhaobiao` online
- PostgreSQL 数据库 `touhaobiao` 已建表并执行 seed / seed-docs
- `https://OLD_SERVER_IP`（Host: touhaobiao.cn）首页 200
- `/api/health` 返回 `ok/ok`
- 管理员 API `/api/me`、`/api/users` 返回 200
- Let's Encrypt 证书已签发（有效期至 2027-01-19，包含 apex + www）
- Nginx 已启用 HTTPS，HTTP 301 跳转 HTTPS
- 每日 02:00 备份 cron 已配置，并成功执行一次
- 前端已用生产 `VITE_API_BASE_URL=/api` 重建，避免浏览器请求 `127.0.0.1:3000`

## 管理员密码

只在服务器 root-only 文件：

```bash
cat ADMIN_PASSWORD_FILE
```

首次登录后必须修改；不要发到聊天/文档。

## 当前公网访问阻塞：百度云域名拦截

从公网访问域名时：

- `http://touhaobiao.cn` 被 302 到 `http://domainwall.cloud.baidu.com/block.html`
- `https://touhaobiao.cn` 连接被重置
- 但直接访问 IP `https://OLD_SERVER_IP`（Host 头）正常 200

这是百度智能云的**域名接入/ICP 备案拦截**，不是 Nginx 或服务器防火墙问题。需要在百度智能云完成该域名的备案/接入备案，通过后域名才能公网访问。

备案通过后无需重新部署；证书已签发，但证书自动续期走 HTTP-01，备案未通过前续期可能失败，备案后确认 `certbot renew --dry-run`。

## 尚未配置

- **短信**：`SMS_PROVIDER` 为空，普通用户暂不能登录；管理员可用密码登录
- **支付**：`PAYMENT_ENABLED=0`，充值走管理员手工核验；商户参数到位后联调再开
- **AI 模型**：新数据库无文本/生图 API Key，管理员登录后到设置中配置
- **站点 Logo / 客服二维码 / 返利比例**：管理员后台配置

## 资源提醒

2 核 / 1.9GB 内存对 LibreOffice 大文件解析和多人同时生成偏紧；正式放量前建议升级到 4GB 以上内存。
