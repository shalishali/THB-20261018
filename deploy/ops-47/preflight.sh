#!/usr/bin/env bash
# 只读预检：不修改任何配置
set +e
echo '== OS =='; cat /etc/os-release 2>/dev/null | head -5
echo '== KERNEL =='; uname -a
echo '== CPU/MEM/DISK =='; nproc; free -h; df -h /
echo '== TOOLS =='
for c in node npm pnpm nginx psql pm2 soffice certbot git curl; do printf '%s: ' "$c"; command -v "$c" || echo missing; done
echo '== SERVICES =='; systemctl is-active nginx postgresql 2>/dev/null
echo '== PORTS =='; ss -lntp 2>/dev/null | grep -E ':(80|443|3000|5432)\b'
echo '== EXISTING OPT =='; ls -la /opt 2>/dev/null
echo '== NGINX SITES =='; ls -la /etc/nginx/sites-enabled 2>/dev/null; ls -la /etc/nginx/conf.d 2>/dev/null
echo '== NGINX CONFIG TEST =='; nginx -t 2>&1
echo '== DNS =='; getent hosts touhaobiao.cn
echo '== EXISTING TOUHAOBIAO =='; ls -la /opt/touhaobiao 2>/dev/null || echo no_opt_touhaobiao
echo '== EXISTING OTHER SITE =='; grep -R "anfang.chengkaitech.cn" -n /etc/nginx 2>/dev/null | head -10
