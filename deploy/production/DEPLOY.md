# 投好标生产部署包说明（touhaobiao.cn）

> 目标服务器：47.109.141.16  
> 域名：touhaobiao.cn（www 可选）  
> 当前状态：HTTP 已由 Nginx 响应；**HTTPS 证书尚未部署成功**，上线前必须配置证书。

## 1. 包内结构

```
touhaobiao-cn-YYYYMMDD/
├── server/                          # Fastify/Prisma 源码（不含 node_modules/.env/data）
├── client/                          # React 源码 + 已构建的 client/dist
├── deploy/
│   ├── production/                  # 本目录：env/nginx/pm2/install
│   ├── backup/                      # 备份恢复脚本
│   └── nginx/ pm2/                  # 通用部署示例
├── docs/                            # 部署/支付/风险说明
├── .env.production.example          # 生产 env 模板
└── DEPLOY.md
```

## 2. 服务器要求

- Linux（Ubuntu 22.04/24.04 等）
- Node.js **24**（至少 22）、pnpm 11
- PostgreSQL 15+
- Nginx
- PM2（`npm i -g pm2`）
- LibreOffice（doc/docx/wps/pdf 解析转换需要）
- 已放行 80/443；**不要**对公网开放 3000/5432

## 3. 部署步骤

```bash
# 1. 解压
sudo mkdir -p /opt/touhaobiao
sudo tar -xzf touhaobiao-cn-YYYYMMDD.tar.gz -C /opt/touhaobiao --strip-components=1
cd /opt/touhaobiao

# 2. 配置生产环境变量
cp .env.production.example server/.env
# 编辑 server/.env：
#   DATABASE_URL / JWT_SECRET / CONFIG_ENCRYPTION_KEY 必填
#   JWT_SECRET 用 openssl rand -hex 32
#   CONFIG_ENCRYPTION_KEY 用 openssl rand -hex 32
#   CORS_ORIGINS / WEB_BASE_URL 已按 touhaobiao.cn 填好
#   SMS_PROVIDER=aliyun 的四项短信参数待审核通过后填写
#   PAYMENT_ENABLED=0（支付未联调前保持关闭）
#   ADMIN_INITIAL_PASSWORD 建议显式设置强密码
mkdir -p data logs backups
chmod 700 data

# 3. 安装后端依赖 + 初始化数据库
cd server
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm run db:push
pnpm run db:seed
pnpm exec tsx prisma/seed-docs.ts

# 4. 启动后端
cd /opt/touhaobiao
pm2 start deploy/production/touhaobiao.cn.pm2.config.cjs
pm2 save
pm2 startup   # 按提示执行一次开机自启

# 5. 配置 Nginx
sudo cp deploy/production/touhaobiao.cn.nginx.conf /etc/nginx/conf.d/touhaobiao.cn.conf
# 申请证书（示例：certbot）并把路径替换到 nginx 配置
sudo nginx -t && sudo systemctl reload nginx
```

## 4. HTTPS 证书

当前直接访问 `https://touhaobiao.cn` 证书不受信任，必须先签发证书。两种方式：

- Let's Encrypt：`certbot --nginx -d touhaobiao.cn -d www.touhaobiao.cn`
- 企业证书：上传 fullchain/key 到 `/etc/nginx/ssl/`，替换 Nginx 配置中的路径

签发后验证：

```bash
curl -I https://touhaobiao.cn/
curl -fsS https://touhaobiao.cn/api/health
```

## 5. 前端

`client/dist` 已包含在包内，Nginx root 直接指向它。若服务器需要重新构建：

```bash
cd /opt/touhaobiao/client
pnpm install --frozen-lockfile
pnpm run build
```

## 6. 上线后验证

1. 打开 `https://touhaobiao.cn/`，登录页正常；
2. 管理员登录 → 设置 → 基本设置，确认 Logo/客服二维码/返利比例；
3. 真实手机号短信登录（需先配置阿里云签名/模板）；
4. 上传招标文件 → 解析 → 目录 → 正文 → 导出 Word；
5. 导出额度不足时 402 弹充值；充值先保持 `PAYMENT_ENABLED=0` 由管理员手工核验；
6. `curl https://touhaobiao.cn/api/health` 返回 `ok`；
7. 配置每日备份 cron（见 `deploy/backup/README.md`）。

## 7. 重要限制

- **单实例**：PM2 必须 `instances: 1` + `fork`，禁止 cluster/reload，否则任务锁/SSE/验证码/限流会失效。
- 生产必须 `NODE_ENV=production`；缺失或写错会被启动校验拒绝（这是保护，不是故障）。
- 支付代码框架已包含，但 `PAYMENT_ENABLED=0` 时充值走管理员手工核验；真实支付联调完成后再改 1。
- 短信未配置阿里云参数时，普通用户无法登录；请先完成短信签名/模板审核。
- 包内**不含** `.env`、数据库、上传文件、日志、备份，请勿把生产数据放回 Git。
- 当前域名已解析到 47.109.141.16；请在服务器防火墙只开放 80/443。
