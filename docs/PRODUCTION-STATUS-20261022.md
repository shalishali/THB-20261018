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

- 数据库快照（迁移时）：仅 `admin` 账号（`mustChangePassword=true`），0 项目、0 订单
- 当前（2026-10-22）：`quota_orders` 共 2 笔（1 笔真实 paid、1 笔误核验已 closed），admin `quotaChars=200000`
- `data` 目录：44KB
- 管理员初始密码由运维单独保管（文件权限 600，不提交仓库）

如果本地开发库中还有真实用户/项目数据，需要另行迁移；当前旧生产库本身没有这些数据。

## 备份

- 脚本：`/opt/touhaobiao/backup.sh`
- Cron：`/etc/cron.d/touhaobiao-backup`，每天 03:15
- 备份目录：`/opt/touhaobiao/backups`，保留 14 天
- 已验证手工执行成功

## 支付

- `PAYMENT_ENABLED=1`（2026-10-22 已开启；支付宝真实小额支付已成功）
- `PAYMENT_CHANNELS=alipay`：充值弹窗只展示支付宝；微信配置仍保留但不对外开放
- 支付宝/微信密钥已从旧服务器迁移到 `/opt/touhaobiao/secrets`
- 支付宝 IP 白名单已加入 `SERVER_IP`；`alipay.trade.query` 已通过（`ACQ.TRADE_NOT_EXIST` 表示签名/IP 校验通过）
- 已修复支付宝 RSA2 签名串：`sign_type` 必须参与签名，否则网关返回 `isv.invalid-signature`
- 微信仍需解决 `APPID_MCHID_NOT_MATCH`（AppID 未绑定商户号），解决前不要把 `wechat` 加入 `PAYMENT_CHANNELS`
- 支付回调域名不变：`/api/payment/alipay/notify`、`/api/payment/wechat/notify`
- 已上线回调丢失兜底：服务每 10 分钟查询最近 pending 支付宝订单；管理端增加“同步支付宝订单”，单笔核对也必须先查支付宝交易，不能无依据点“核验入账”。
- 2026-10-22 发现一笔 `QMVJEREQ2D9D56F` 被人工误核验为 paid，但支付宝查询为 `ACQ.TRADE_NOT_EXIST`；已改为 `closed` 并扣回 100000 额度（admin 从 300000 恢复 200000），审计 `quota.order.revert`。真实支付订单 `QMVJEW2ZU57AF4E` 保持 paid。

## 短信

- `SMS_PROVIDER=aliyun`，已配置阿里云 AccessKey、签名 `成都解台网络科技`、模板 `SMS_512516697`（验证码 5 分钟有效）
- 已生成独立 `SMS_CODE_SECRET`；AccessKey/密钥只写入服务器 `.env`（600），未提交仓库
- 2026-10-22 生产向测试号发送验证码，阿里云 `QuerySendDetails` 结果：
  - `USER_PHONE`：`DELIVERED`（sendStatus=3）
  - `TEST_PHONE_3`：`DELIVERED`（sendStatus=3）
  - `TEST_PHONE_2`：`PORT_NOT_REGISTERED`（号码未在运营商登记，属号码问题，不是短信通道故障）
- 已用 `USER_PHONE` 收到的验证码完成一次真实短信登录，`POST /api/login-sms` 返回 200
- 短信发送不再要求图形验证码（2026-10-22 产品调整）；仍受 IP 限流、同号 60 秒冷却、单号每日 10 条限制。图形验证码只保留在密码登录。

## 生产验证修复（2026-10-22）

- 登录页图形验证码空白：生产构建机环境把 `VITE_API_BASE_URL` 注入成 Windows 本地路径，
  前端把验证码/登录请求发到了错误地址。已在 `client/vite.config.ts` 中把生产构建固定为
  同源 `/api`，并增加验证码加载失败时的“点击重试”提示。
- 已重新构建并部署 `client/dist`；Playwright 验证验证码图片 `naturalWidth=150` 正常显示。

## 登录与拉新归因（2026-10-22）

- 登录页改为纯「手机号 + 短信验证码」，按钮文案为「登录」；未注册手机号验证通过后自动建号，不再展示注册入口。
- 删除登录页的手填「邀请码（选填）」字段；邀请链接 `/?invite=CODE` 由页面自动读取并随首次短信登录提交，用户无需输入。
- 支持渠道参数 `utm_source` / `from` / `channel` 自动归因；无效邀请码只忽略归因，不再阻断登录。
- 管理端「数据看板 → 概览」新增「用户拉新来源」：按近 N 天新增统计邀请链接/直接访问/渠道来源；「累计用户」卡展示累计邀请注册人数。
- 服务端注册活动记录新增 `source` 字段（`activity_logs.detail`，无需数据库结构变更）。

## 密码登录与头像设置密码（2026-10-22）

- 登录页原来只有「管理员登录」入口，现改为「密码登录」，支持手机号账号或管理员账号 + 密码登录；仍要求图形验证码 + IP 限流。
- 已登录用户点击顶栏头像可打开「设置登录密码」弹窗（`POST /api/me/password`）；短信自动建号用户初始密码是服务端随机串，用户不知道，因此设置密码不要求旧密码。
- 设置密码不递增 `tokenVersion`，不会把当前会话踢下线；短信验证码登录继续可用。

## 尚未完成/需业务确认

- 域名 ICP 接入备案状态需在阿里云侧确认
- 服务器原有 MySQL/Redis/宝塔面板等端口对外监听，建议按运维规范收紧安全组
- 旧服务器 `OLD_SERVER_IP` 仍保留，可作回滚
