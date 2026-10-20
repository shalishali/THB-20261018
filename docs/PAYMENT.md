# 支付接入说明（支付宝电脑网站支付 + 微信 Native）

> 当前状态：**框架已实现并通过签名/解密单元测试，但尚未接入真实商户号联调。**
> 未完成沙箱/小额真实支付验证前，不要开放充值入口。

## 1. 已实现

- 创建充值订单：`POST /api/quota/orders`（原有）
- 发起支付：`POST /api/quota/orders/:id/pay`
  - 支付宝：返回 `type=redirect` + 收银台 `payUrl`
  - 微信：返回 `type=qrcode` + `qrDataUrl`（前端直接展示二维码）和 `codeUrl`
- 支付宝异步通知：`POST /api/payment/alipay/notify`
- 微信异步通知：`POST /api/payment/wechat/notify`
- 回调安全：
  - 支付宝 RSA2 验签 + `app_id` + 金额校验
  - 微信 APIv3 平台公钥验签 + AES-256-GCM 解密 + 商户号/AppID/金额校验
- 入账幂等：复用 `markQuotaOrderPaid`（订单 pending→paid + 加额度 + 返利同一事务，重复回调不重复加额度）
- 前端充值弹窗：创建订单后自动发起支付；支付宝新窗口跳转、微信展示二维码；每 3 秒轮询订单状态，到账后自动刷新额度。

## 2. 生产配置

字段见 `server/.env.example`。商户号/私钥/证书**只放服务器 `.env`**，不要提交仓库或发聊天。

```text
PAYMENT_ENABLED=1

PAYMENT_ALIPAY_APP_ID=
PAYMENT_ALIPAY_PRIVATE_KEY=      # 应用私钥（PKCS8，支持原文或 \n 转义）
PAYMENT_ALIPAY_PUBLIC_KEY=       # 支付宝公钥
PAYMENT_ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
PAYMENT_ALIPAY_NOTIFY_URL=https://你的域名/api/payment/alipay/notify
PAYMENT_ALIPAY_RETURN_URL=https://你的域名/?recharge=done

PAYMENT_WECHAT_MCH_ID=
PAYMENT_WECHAT_APP_ID=
PAYMENT_WECHAT_API_V3_KEY=       # 必须 32 字节
PAYMENT_WECHAT_CERT_SERIAL_NO=   # 商户证书序列号
PAYMENT_WECHAT_PRIVATE_KEY=      # 商户私钥（PKCS8）
PAYMENT_WECHAT_PLATFORM_PUBLIC_KEY=  # 微信支付平台公钥
PAYMENT_WECHAT_PLATFORM_SERIAL_NO=   # 可选：平台证书序列号，配置后强校验
PAYMENT_WECHAT_NOTIFY_URL=https://你的域名/api/payment/wechat/notify
```

未配置完整时：
- `GET /api/quota` 正常返回套餐；
- 发起支付返回 503「支付渠道尚未配置」；
- 管理员仍可在数据看板手工核验订单入账。

## 3. 联调清单

1. 用真实域名 HTTPS 配置回调（支付宝/微信商户后台填同一 URL）；
2. 沙箱或小额真实支付：支付宝 0.01 元、微信 0.01 元；
3. 验证：
   - 支付成功回调后订单变 `paid`、额度增加、返利流水生成（如有邀请关系）
   - 重复回调不重复加额度
   - 篡改金额/签名/商户号被拒绝（400/503）
   - 关闭/取消订单后回调不会错误入账
4. 支付宝 return_url 回到前端后，轮询确认到账；
5. 微信 Native 二维码可扫码、支付后自动到账；
6. 配置告警：回调失败、验签失败、金额不一致需要日志/告警。

## 4. 已知限制（后续迭代）

- 退款、关单 API 尚未接入（当前需商户后台人工处理）；
- 无支付对账任务（建议每日拉取支付宝/微信账单与 `quota_orders` 对账）；
- 微信平台证书轮换需手动更新公钥；
- 支付宝证书模式、微信 JSAPI/H5 支付暂不支持；
- 前端轮询间隔 3 秒，页面关闭后需重新打开查看订单状态。
