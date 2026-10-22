# 投好标迁移到 SERVER_IP 运维说明

目标：在阿里云服务器 `SERVER_IP` 上部署 `touhaobiao.cn`，**不覆盖服务器上已有的 `ht.anfang.chengkaitech.cn` 站点**。

## 0. 当前状态

- 域名目前已解析到 `SERVER_IP`
- 新服务器上已有 Nginx 和另一个站点/证书（`ht.anfang.chengkaitech.cn`）
- 当前项目原运行在 `OLD_SERVER_IP`，数据库约 11MB，data 目录约 11MB
- 证书不能复用，必须为 `touhaobiao.cn` 单独签发

## 1. 先做只读检查（不要改配置）

```bash
bash deploy/ops-47/preflight.sh
```

确认：

- 系统是 Ubuntu/Debian 还是 Alibaba Cloud Linux/CentOS
- Nginx、PostgreSQL、Node、pnpm、PM2 是否已装
- 80/443 端口是否已监听
- `/opt/touhaobiao` 是否已存在
- 现有站点配置，避免覆盖 `ht.anfang.chengkaitech.cn`

## 2. 系统依赖

Ubuntu/Debian：

```bash
apt-get update
apt-get install -y nginx postgresql postgresql-contrib certbot \
  libreoffice --no-install-recommends fonts-noto-cjk curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pnpm@11 pm2
```

Alibaba Cloud Linux/CentOS：

```bash
dnf install -y nginx postgresql-server postgresql-contrib certbot \
  libreoffice fonts-noto-cjk curl ca-certificates
# Node.js 24、pnpm、PM2 按阿里云官方 NodeSource/镜像方案安装
```

> 中文字体必须安装，否则 LibreOffice 导出排版会异常。

## 3. 部署代码

```bash
mkdir -p /opt/touhaobiao
tar -xzf touhaobiao-cn-ops-*.tar.gz -C /opt/touhaobiao --strip-components=1
cd /opt/touhaobiao
mkdir -p data logs backups secrets/wechat secrets/alipay
chmod 700 data backups secrets secrets/wechat secrets/alipay
```

### 3.1 环境变量

```bash
# 已部署的服务器直接修改现有 .env；全新环境先复制 server/.env.example
cp server/.env.example server/.env
chmod 600 server/.env
```

必须填写/保持：

- `DATABASE_URL`
- `JWT_SECRET`
- `CONFIG_ENCRYPTION_KEY`
- `ADMIN_INITIAL_PASSWORD`（首次建库时）
- `CORS_ORIGINS=https://touhaobiao.cn,https://www.touhaobiao.cn`
- `WEB_BASE_URL=https://touhaobiao.cn`
- `YIBIAO_DATA_DIR=/opt/touhaobiao/data`
- `PAYMENT_ENABLED=1`（2026-10-22 已开启；首次真实支付/回调需验证后再对用户开放）
- `PAYMENT_CHANNELS=alipay`（默认只开放支付宝；微信未绑定 AppID 前不要加 `wechat`）
- 支付密钥文件路径

**如果从旧服务器迁移，必须原样复制旧 `.env` 里的 `JWT_SECRET` 和 `CONFIG_ENCRYPTION_KEY`**，否则已登录用户全部失效、AI Key 无法解密。

### 3.2 安装依赖和初始化

```bash
cd /opt/touhaobiao/server
pnpm install --frozen-lockfile
pnpm exec prisma generate
```

**全新数据库**：

```bash
pnpm run db:push
pnpm run db:seed
pnpm exec tsx prisma/seed-docs.ts
```

**从旧服务器迁移数据**：不要先 seed，先按第 4 节恢复数据库。

## 4. 从 OLD_SERVER_IP 迁移数据

在旧服务器执行（旧服务器当前仍可访问）：

```bash
cd /opt/touhaobiao
set -a; . server/.env; set +a
mkdir -p /opt/touhaobiao/migrate
pg_dump "$DATABASE_URL" -Fc -f /opt/touhaobiao/migrate/touhaobiao.dump
tar -czf /opt/touhaobiao/migrate/data.tar.gz -C /opt/touhaobiao data
```

将 `touhaobiao.dump`、`data.tar.gz` 安全传到新服务器（不要经过公开网盘）。

新服务器：

```bash
sudo -u postgres createuser -P touhaobiao
sudo -u postgres createdb -O touhaobiao touhaobiao
cd /opt/touhaobiao
pg_restore -d "$DATABASE_URL" --no-owner --no-acl migrate/touhaobiao.dump
tar -xzf migrate/data.tar.gz -C /opt/touhaobiao
chmod 700 data
chown -R root:root data
```

然后：

```bash
cd server
pnpm exec prisma generate
pnpm run db:check   # 确认 schema 一致（如有差异再 db:push）
```

## 5. Nginx 站点（不影响现有站点）

```bash
cp deploy/ops-47/touhaobiao.cn.nginx.conf /etc/nginx/sites-available/touhaobiao.cn
ln -s /etc/nginx/sites-available/touhaobiao.cn /etc/nginx/sites-enabled/touhaobiao.cn
```

证书签发前，先把配置里的证书路径替换为 certbot 路径，或先只启用 HTTP 80 的 server 块完成 ACME，再启用 443。

```bash
mkdir -p /var/www/html/.well-known/acme-challenge
certbot certonly --webroot -w /var/www/html \
  -d touhaobiao.cn -d www.touhaobiao.cn \
  --non-interactive --agree-tos --register-unsafely-without-email
nginx -t && systemctl reload nginx
```

**不要删除** `/etc/nginx/sites-enabled/` 里的其他站点配置。  
如果新服务器使用 `/etc/nginx/conf.d/` 而不是 `sites-enabled`，把本配置放到 `/etc/nginx/conf.d/touhaobiao.cn.conf`。

## 6. 启动后端

```bash
cp deploy/ops-47/touhaobiao.cn.pm2.config.cjs /opt/touhaobiao/
cd /opt/touhaobiao
pm2 start deploy/ops-47/touhaobiao.cn.pm2.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root
```

验证：

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -I https://touhaobiao.cn/
```

## 7. 备案

主站在中国大陆阿里云地域时，域名需要办理**阿里云接入备案**。  
接入备案通过前，域名可能被阿里云拦截；不要因为暂时打不开就反复改 DNS。

## 8. 支付

迁移完成、域名和 HTTPS 正常后，再处理：

- 支付宝：应用公钥/私钥、支付宝公钥、APPID、IP 白名单、电脑网站支付签约
- 微信：AppID 绑定商户号、Native 支付、APIv3 密钥、商户私钥、微信支付公钥

`PAYMENT_ENABLED=1` 已开启；在完成首笔真实支付和回调验签前，仍建议保留管理员手工核验入口。

## 9. 回滚

保留旧服务器和旧数据库备份至少 7 天。  
如果新服务器异常，把 DNS A 记录切回 `OLD_SERVER_IP` 即可恢复旧站。
