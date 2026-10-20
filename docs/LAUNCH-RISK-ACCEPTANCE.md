# 上线前风险接受记录

日期：2026-10-21  
项目：投好标（THB-20261018）  
状态：内测/预发布前，以下决策由产品负责人确认。

## 1. 数据库结构升级方式：保持现状

- 决定：暂不建立 Prisma baseline migrations，继续使用 `prisma db push`。
- 约束：
  1. 每次发布/改表结构前，必须先执行 `deploy/backup/backup.sh` 备份 PostgreSQL 与 `YIBIAO_DATA_DIR`；
  2. 部署前后执行 `pnpm run db:check`，有漂移必须先处理；
  3. 生产禁止 `db push --force-reset`；
  4. 待业务稳定后，再安排停机窗口补 baseline migrations。
- 备份/恢复步骤见 `deploy/backup/README.md`。

## 2. 第三方依赖高危提示：先上线，后续升级

- 现状：`pnpm audit --prod` 报告 53 条（26 high / 21 moderate / 6 low），主要集中在 `undici`、`fast-uri`、`@xmldom/xmldom`、`brace-expansion`、`deepmerge-ts` 等传递依赖。
- 决定：本次上线不升级，记录为已知风险；下一次维护窗口单独升级并回归 Word 导出、Agent、文档解析。
- 约束：上线后关注安全公告；如出现可远程利用的高危漏洞，优先安排紧急升级。
- 说明：当前 npmmirror 镜像不支持 audit，以上数据来自 `registry.npmjs.org` 的只读审计。

## 3. Mermaid 图外发：允许

- 决定：保留 `mermaid.ink` 外部转图回退，保证导出流程图效果。
- 已知影响：未使用浏览器预渲染的 Mermaid 图代码会发送到 `mermaid.ink` 第三方服务，可能包含招标/方案内容。
- 约束：如后续客户要求数据不出内网，应改为强制前端预渲染或自托管渲染，并关闭外部回退。
- 相关代码：`server/src/export/mermaid.ts`、`server/src/export/docxBuilder.ts`。

## 4. 计费数据差异：暂不修改

- 管理员账号 `quotaUsedChars` 331,372，消费流水合计 256,778，差 74,594 字；判断为消费流水功能上线前的历史导出。
- 决定：不改历史数据；上线前如需财务确认，按消费流水与备份记录人工对账。
- 真实用户 `USER_PHONE` 的 5 笔 pending 订单保留未动。

## 5. 充值价格口径：沿用当前后台配置

- 最终价格：10 万字 ¥3.9 / 20 万字 ¥5 / 50 万字 ¥10 / 110 万字 ¥20；注册赠送 10 万字。
- 已同步修改登录页、推广文案、设计 mockup 中的价格表述。
- 已产生订单按订单快照（金额/字数）入账，不按后台当前价格重算。
- 后台 key 已统一为 `plan-110w`（110 万字 ¥20）；历史订单中无 `plan-60w` 记录，重命名不影响已有订单。

## 6. 支付网关：待商户参数

- 已选：支付宝电脑网站支付 + 微信 Native。
- 现状：代码尚未接入支付下单/回调验签；`server/.env.example` 与 `docs/DEPLOYMENT.md` 已列出所需参数和联调清单。
- 上线前必须：配置商户参数 → 沙箱/小额真实支付联调 → 回调幂等、退款/关单、对账验证。未完成前不开放充值入口。

## 7. 上线前仍必须确认的配置

- `NODE_ENV=production`
- 高熵 `JWT_SECRET`（禁止 `.env.example` 占位符）
- `CORS_ORIGINS`
- `CONFIG_ENCRYPTION_KEY`
- `SMS_PROVIDER=aliyun` + AccessKey/签名/模板
- `HOST=127.0.0.1`（Nginx 反代）与 HTTPS
- PM2 `instances: 1` + `fork`
- 数据库/数据目录备份与 `/api/health` 探活
