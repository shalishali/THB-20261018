#!/usr/bin/env bash
# 投好标生产初始化脚本（在解压后的部署目录根执行）
# 用法：sudo bash deploy/production/install.sh /opt/touhaobiao
set -euo pipefail

ROOT="${1:-/opt/touhaobiao}"
cd "$ROOT"

command -v node >/dev/null || { echo "缺少 Node.js"; exit 1; }
command -v pnpm >/dev/null || { echo "缺少 pnpm"; exit 1; }
command -v pm2 >/dev/null || { echo "缺少 PM2"; exit 1; }

if [ ! -f server/.env ]; then
  cp .env.production.example server/.env
  chmod 600 server/.env
  echo "已生成 server/.env，请先填写 DATABASE_URL / JWT_SECRET / CONFIG_ENCRYPTION_KEY / 短信参数后再运行本脚本。"
  exit 1
fi
if grep -q '^JWT_SECRET=CHANGE_ME$' server/.env; then
  echo "JWT_SECRET 仍是占位符，请先生成：openssl rand -hex 32"
  exit 1
fi
if grep -q '^CONFIG_ENCRYPTION_KEY=CHANGE_ME$' server/.env; then
  echo "CONFIG_ENCRYPTION_KEY 仍是占位符，请先生成随机值"
  exit 1
fi

mkdir -p data logs backups
chmod 700 data

cd server
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm run db:push
pnpm run db:seed
pnpm exec tsx prisma/seed-docs.ts
cd ..

pm2 start deploy/production/touhaobiao.cn.pm2.config.cjs
pm2 save
pm2 status
echo "后端已启动；请配置 Nginx/HTTPS 后验证 https://touhaobiao.cn/api/health"
