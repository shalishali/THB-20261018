# AGENTS.md

本文件面向所有在本仓库工作的 AI 代理（DeepSeek Harness / Claude Code / GLM 等）与人类开发者。
**动手前先读完本文件**；它与代码冲突时以代码为准，并请顺手更新本文件。

## 1. 项目是什么

「投好标」——基于 OpenBidKit_Yibiao 二次开发的 **SaaS 化 Web 版**（多用户、字数计费、后台管理）。
技术栈：React 19 + Vite 7（`client/`）、Fastify 5 + Prisma 6 + PostgreSQL（`server/`）。
许可证 AGPL-3.0-only：对外提供服务时必须保留源码入口与归属（`LICENSE` / `NOTICE` / `ATTRIBUTION.md`）。

## 2. 目录速览

```
client/src/
  app/            路由、登录页、菜单、Provider
  features/       业务模块（technical-plan / duplicate-check / rejection-check / settings ...）
  shared/         api（http/bridge/sse）、ui、权限、类型
server/src/
  routes/         HTTP 路由（鉴权、项目、导出、配额、任务、统计...）
  tasks/          任务引擎 + runners（大纲/正文/查重/废标/配图）
  ai/             AI 服务、请求队列、重试、用量统计
  auth/           JWT、验证码、短信、权限、限流
  quota/          字数额度、订单、返利
  document/       解析（mammoth/pdfjs/SheetJS + LibreOffice 可选）与路径层
  export/         Word 导出（docx）
server/prisma/    schema.prisma（唯一真相）、seed、seed-docs
.github/workflows/ci.yml   CI（tsc / build / 单测）
```

## 3. 常用命令

```powershell
# 依赖（pnpm 10/11；allowBuilds 已在各目录 pnpm-workspace.yaml 放行）
cd server; pnpm install
cd client; pnpm install

# 数据库
cd server
pnpm exec prisma generate
pnpm run db:push          # 结构同步（新增表/索引）
pnpm run db:check         # 对比线上库与 schema，有漂移会打印 SQL 并非 0 退出
pnpm run db:seed          # 初始管理员 + 基础数据
pnpm exec tsx prisma/seed-docs.ts

# 开发
cd server; pnpm run dev   # tsx watch，默认 :3000
cd client; pnpm run dev   # vite，默认 :5173

# 校验（与 CI 一致）
cd server; pnpm exec tsc --noEmit -p tsconfig.json
cd client; pnpm exec tsc --noEmit -p tsconfig.json
cd client; pnpm run build
cd server; $f=(Get-ChildItem src -Recurse -Filter *.test.ts).FullName; pnpm exec tsx --test @f
```

## 4. 编码约定

- TypeScript strict；新增文件保持现有风格（中文注释、函数式工厂、`createXxxRoutes(app)`）。
- **数据库**：schema 变更必须同步 `prisma/schema.prisma`，并跑 `db:push` + `db:check`；生产禁止 `db push --force-reset`。
- **路由**：受保护路由挂在 index.ts 的 protected 组；项目级路由必须经过 `createRequireProject`（`X-Project-Id`），不要信任客户端传入的 projectId/ownerId。
- **权限**：模块门禁用 `createRequireModule`；管理员专属接口用 `createRequireAdmin`；不要用前端隐藏当权限。AI 代理接口（`/ai/chat`、`/ai/request-json`、`/ai/list-models`、`/ai/test-image-model`、`/ai/test-key-pool`）仅管理员可调用；正文/大纲/审计等业务链路走 `tasks/service` 内部 `aiService`，不经过该代理。
- **限流**：公开/高成本接口用 `createRateLimit`；短信发送必须叠加图形验证码 + 同号冷却 + 日限。
- **AI 调用**：所有文本请求必须走 `getAiService()`（全局队列/公平调度/重试/埋点都在里面），不要直接 fetch 模型接口。
- **错误**：返回 `{ error: '中文提示' }`；不要把上游原始错误/密钥回给客户端。
- **路径**：文件读写一律走 `document/paths.ts` 的 `containedResolve`，禁止字符串拼接路径。

## 5. 不允许做的事

- 不要提交 `.env`、`server/data/`、`node_modules/`、日志、数据库备份；不要打印或写入任何 API Key / JWT / 连接串。
- 不要删除或回滚以下已定型的设计（改之前必须确认）：
  - **登录**：普通用户只能「手机号 + 短信验证码」，`/register`、`/forgot-password`、`/reset-password` 已下线为 410；管理员即使绑定手机号也保留密码登录（break-glass，防短信服务未配置/故障时锁死运维入口）。
  - **知识库 / 资产资质库 / 人员资质库**：前后端已下线，不要恢复（除非产品明确要求并给出数据模型）。
  - **PDF 导出**：已下线，只保留 Word（PDF 仍作为解析输入格式）。
  - **一致性修复**：默认 `normal`（逐节小上下文），Agent 模式是显式可选的「高消耗深度修复」，不要改回默认。
- 不要并发修改同一批文件（多 agent 同时改会造成半成品，之前已发生过 `SettingsPage.tsx` 语法损坏）。

## 6. 当前关键机制（改之前先理解）

- **认证**：`/api/sms/send`（须图形验证码）→ `/api/login-sms`（未注册且同意协议自动建号）→ `/api/reset-password-sms`。验证码只存哈希、5 分钟、5 次尝试、一次性。图形验证码为 **PNG 位图**（答案不出现在响应体；E2E 用 `E2E_CAPTCHA_BYPASS=1` 且仅非生产生效）。短信必须显式 `SMS_PROVIDER=aliyun|mock`，未设置时发送接口 503（不再隐式 mock）；`devCode` 仅非生产回显。
- **计费**：字数额度**只在导出时扣**（`chargeExportOnce`：扣额度 + 抢占内容指纹 + 写流水同事务，并发同内容只扣一次）；生成阶段不计量。
- **任务引擎**：单进程内存态（activeTasks/组锁/AI 队列/SSE/配置缓存）。**只能单实例部署**；PM2 不要开 cluster。
- **任务落库**：大纲/小节当前是「全量 deleteMany + createMany」，大文档高并发下是已知瓶颈，优化时改按 nodeId 增量 upsert。
- **AI 队列**：`text_request_queue_limit`（全局并发，热生效）与 `concurrency_limit`（单任务 worker 数）是两个不同闸门，见 `docs/` 与设置页说明。
- **SSE**：`/api/events?projectId=`，按项目隔离；无重放缓冲，前端断线只靠重连。

## 7. 测试与 CI

- 单测：`server/src/**/*.test.ts`，`node:test` + `node:assert/strict`，**全部使用桩对象、不依赖数据库**（CI 无 Postgres）。当前 164 个用例全绿。
- CI（`.github/workflows/ci.yml`）门禁：
  - client `tsc` 必须 0 错误；
  - client `vite build` 必须通过；
  - server `tsc` 为「棘轮」：历史基线 **55** 个错误（docx/agent 类型定义为主），**只禁止新增**；清理后请把 `ci.yml` 里的基线数字同步调低。
  - 所有单测必须通过。
- 改完代码至少跑：server tsc、client tsc、server 单测；涉及 UI 再跑 `client build`。
- **E2E（Playwright）**：`e2e/` 目录。本地跑前先起 `server`(:3000) 与 `client`(:5173)，并确保 `SMS_PROVIDER=mock`、`E2E_CAPTCHA_BYPASS=1`（登录用例靠 devCode 拿验证码答案）；然后 `cd e2e; pnpm test`。CI 的 `e2e` job 会自动起 Postgres、灌 schema、拉起前后端并跑全部用例。

## 8. Windows 环境注意

- 终端中文输出可能因编码显示乱码，不影响文件内容；用 `-Encoding UTF8` 读取日志。
- Vite dev server 会因源码目录里的临时文件（`*.tmpdir/`）抛 EBUSY 崩溃；`vite.config.ts` 已忽略，但不要往 `src/` 里写临时文件。
- `pnpm exec` 在 pnpm 10/11 下曾因 ignored-builds 中断；`pnpm-workspace.yaml` 已修，若复现请检查 `allowBuilds`。
- Prisma Client 生成时若服务端在跑会 `EPERM`（DLL 被占用）：先停服务再 `prisma generate`。

## 9. 提交规范

- 一个主题一个 commit；信息用 `type(scope): 摘要`（feat/fix/chore/docs/refactor/test），正文写「为什么」。
- 提交前：`git status` 确认无 `.env`/临时文件；跑一遍第 7 节的校验。
- 不强制 DCO/签名；但**不要 force push 已被他人拉取的分支**。

## 10. 需要决策时

涉及以下内容先问产品/负责人，不要自行决定：计费口径、免费额度、返利比例、模块上下线、管理员权限边界、AGPL 源码分发方式。
