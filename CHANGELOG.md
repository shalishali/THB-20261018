# 变更日志

本文件记录对外可见的功能、接口与数据结构变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [未发布] - 2026-10-19 · 第十四批（联调测试通道）

- **普通用户临时密码登录**：新增 `ALLOW_PASSWORD_LOGIN=1`（**仅非生产生效**，`NODE_ENV=production` 时强制关闭）。短信服务未接入前，管理员可在「用户管理 → 编辑用户 → 重置密码」给普通用户设密码，再从登录页「管理员登录」用手机号/用户名 + 密码登录，便于测试功能。
- `.env.example` 补充该开关说明；生产环境无需设置，设置了也不生效。

## [未发布] - 2026-10-19 · 第十三批（仪表盘细节）

- **管理员项目列表增加「创建人」列**：显示在编号左侧（`ownerName`，缺省显示用户名），支持按创建人搜索；普通用户仍只看到自己的项目，不显示该列。

## [未发布] - 2026-10-19 · 第十二批（20 人容量配套）

- **每人限 1 个正文生成任务**：按项目 owner 跨项目统计，同一用户已有正文任务运行时再启动返回 409 中文提示；可用 `MAX_CONTENT_GENERATION_TASKS_PER_USER` 调整（默认 1）。防止单人开多个项目占满全局并发池。
- **正文落库节流 3s → 10s**：每任务全量快照重写频率降到 1/3，20 人并发时数据库写压力显著下降；进度条与 SSE 不受影响（走 updateTask，不依赖落库）。
- **排队位次可见**：AI 队列等待日志改为「排队第 N 位（前方 N-1 个请求）」，用户能判断是排队还是卡死。

## [未发布] - 2026-10-19 · 第十一批（仪表盘口径修复）

- **「进行中」数量与列表不一致**：卡片原先统计 `technical_plan_task.status='running'`，但服务重启后内存任务丢失、DB 里又没有 running 行，数字恒为 0，而列表把所有 `project.status='active'` 项目都显示成「进行中」，两者直接矛盾。现统一口径：**未完成 = 进行中**（`total - completed`），卡片改为「进行中项目」；列表完成判定改用 `isProjectComplete`（完成项目显示「已完成」而不是「进行中」）。

## [未发布] - 2026-10-19 · 第十批（P2 收尾）

- **401 不再整页刷新**：axios 拦截器广播 `yibiao:auth-expired`，AuthProvider 清理登录态回登录页；编辑中的正文/导出进度不再因 token 过期整页丢失。
- **登出清理彻底**：`logout()` 现在同时 `queryClient.clear()` + `setActiveProjectId(null)`，同标签页换号不再短暂展示上一账号数据、也不会被锁到他人的 projectId。
- **设置页权限对齐**：非管理员隐藏「文本模型 / 生图模型」页签及平台级「文本请求队列上限」输入（此前可见但点击必 403）。
- **Agent 状态脱敏**：`GET /api/agent/status` 仅管理员可读（此前任何登录用户都能读到 sidecar 状态与文案）。
- **额度溢出防护**：套餐与注册赠送上限 20 亿 → 10 亿；核销前预检「入账后余额 ≤ 20 亿」（int4 上限）；管理员设额度钳制到 20 亿，避免订单永久 pending + 500。
- **AI 重试只保留一层**：队列层默认不再重试（`retryAtQueueLevel` 默认 false），由 runner 内部 `runWithAiRetry`（带退避）负责；单请求最坏执行次数 9 → 3，坏请求不再长期占住全局并发槽。
- **生图超时真正生效**：把 `signal` 传进 `fetch`，超时会真正中断上游请求；同时生图禁用自动重试（非幂等），避免超时重试重复生图、按次计费翻倍。
- **首屏体积**：路由级 `React.lazy` + `Suspense`，`vendor-radix/query/markdown` 单独拆块；主包 1.11MB → 361KB（gzip 115KB），登录页不再加载 25+ 业务页代码。

## [未发布] - 2026-10-19 · 第九批（P0/P1 安全与稳定性加固）

上线前按 P0/P1 清单集中修复，含两轮独立代码审计发现的额外 P0。

### 计费与数据正确性

- **导出计费绕过（P0）**：`textCount` 此前剔除 Markdown 围栏代码块，但导出渲染会把 `<pre><code>` 原样写进 Word —— 把正文包进围栏即可 0 字免费导出。现围栏内容计入计费，并新增「0 字拒绝导出」不变量。
- **导出预检与限流（P1）**：导出改为先计数 + 余额预检再渲染（余额不足直接 402，不做重渲染）；新增 5 次/分钟限流；body 上限 50MB → 10MB。
- **项目清空后数据复活（P1）**：正文 runner 的节流落库/暂停落库路径补 `cancelled` 守卫，clear 后不再把旧快照写回。
- **任务组锁误删（P1）**：`start-*` 失败兜底原先按 type 盲删 `activeTasks`，409 冲突路径会摘掉仍在运行任务的锁与控制柄；改为按本次启动 token 比对后删除。

### 认证与密钥

- **图形验证码明文下发（P0）**：旧实现把字符以 `<text>` 明文写进 SVG，脚本可直接读出答案绕过短信人机校验。改为服务端 canvas 渲染 PNG（`@napi-rs/canvas`），响应体只含位图；单测改用同进程 test-only 取值函数，E2E 用 `E2E_CAPTCHA_BYPASS=1`（仅非生产生效）。
- **配置写接口泄漏平台密钥（P0）**：`PUT /api/config/user` 返回未脱敏的完整合并配置，任意登录用户一次空 body 即可拿到全部 AI Key。现统一 `redactSecrets`（含生图 Key 池与 MinerU token），并补单测。
- **短信隐式 mock（P1）**：`SMS_PROVIDER` 未显式设置时不再回落 mock（改为 503）；mock 日志不再打印验证码明文；`devCode` 仅非生产回显。
- **短信尝试次数并发绕过（P1）**：改为原子 `increment ... WHERE attempts < 5` 先占后比，并发下不再放大可试次数。
- **短信登录账号接管（P1）**：`/login-sms`、`/reset-password-sms` 只按 `phone` 定位账号，移除 `username` 匹配（防手机号同名存量账号被接管）。
- **非管理员保存设置破坏生图配置（P1）**：个人偏好只允许切 provider，服务端按平台 profile 补齐 key/base_url/model，不再用残缺对象覆盖 `image_model_profiles`。
- 管理员绑定手机号后仍保留密码 break-glass（见第八批）。

### 可用性与客户端

- **SSE 请求风暴（P1）**：未选定 projectId 不再建立连接；400/401/403/404 视为致命错误停止重试（此前新用户每秒 400 无限重试）。
- **超时（P1）**：客户端默认超时 30s → 120s；上传类 10 分钟、语义化改写/图表生成 5 分钟。
- **上传内存（P1）**：文档解析改为流式落盘（不再 `toBuffer` 全量进内存），全局单文件上限 50MB。
- **CORS/安全头（P1）**：生产未配置 `CORS_ORIGINS` 直接启动失败；`credentials` 收窄为 false；新增 CSP（后端 + nginx 示例）。
- **Markdown 协议相对链接**：`//evil.com` / `/\evil.com` 降级为纯文本，避免同标签页被带走。

### 依赖与工程

- 升级：`fastify` 5.12.7、`@fastify/multipart` 10.1.4、`pdfjs-dist` 6.4.299（显式 `isEvalSupported:false`）、`xlsx` → `@e965/xlsx@0.20.3`（SheetJS 官方 0.20.3 的 npm 镜像）、`adm-zip` 0.6.1、`markdown-it` 14.3.3、`undici` 6.28.1、`image-size` 2.0.4。
- **删除知识库死模块**（`server/src/knowledge-base/`，约 1000 行）：其访问的 Prisma 模型早已从 schema 删除，旧项目残留 `referenceKnowledgeDocumentIds` 时会 `TypeError`；注入改为 `null` 后 runners 安全跳过。服务端 tsc 基线 159 → 55。
- 单测 164 个（新增配置脱敏、计费口径等回归）；E2E 7 条全绿；CI 棘轮基线同步降到 55。

> 残留：`fast-uri`/`@xmldom/xmldom`/`deepmerge-ts`/`undici@8` 的传递依赖高危通告仍在（来自 docx/agent SDK），需单独开依赖 PR 升级，不能盲目 override（会破坏导出/agent 运行时）。

## [未发布] - 2026-10-19 · 第八批（AI 代理收紧 + 管理员手机号）

- **AI 代理接口收紧为仅管理员**：`POST /api/ai/chat`、`POST /api/ai/request-json` 此前对任意登录用户开放，可被脚本当免费 LLM 网关消耗平台 token（仅有 50k 输入 / 8k 输出钳制与 30 次/分钟限流）。现与 `list-models`/`test-image-model`/`test-key-pool` 一致，统一返回 403「仅管理员可调用 AI 代理」。正文生成、大纲、审计等业务链路走 `tasks/service` 内部 `aiService`，不经过该代理，不受影响。
- **管理员绑定手机号**：`admin` 账号绑定管理员手机号（数据库变更，不入代码），可走短信验证码登录；`/api/login` 同时为管理员保留密码 break-glass（短信服务未配置或故障时仍能进后台），非管理员手机号账号仍强制短信登录。
- 新增 5 个单测（AI 代理门禁 4 个 + 管理员密码登录 1 个），单测总数 156 → 161。

## [未发布] - 2026-10-19 · 第七批（登录改造：短信验证码）

普通用户不再使用密码登录——**手机号 + 短信验证码成为唯一登录因子**，同时堵住上线前「手机号未验证 + 登录即建号」的白嫖链。

- 新增：`POST /api/sms/send`（发送验证码，**必须先过图形验证码**；同号 60s 冷却、每号 24h ≤10 条、IP 10 次/10 分钟）。
- 新增：`POST /api/login-sms`（手机号 + 验证码登录；未注册且勾选协议时自动建号，邀请码选填保留归因）。
- 新增：`POST /api/reset-password-sms`（验证码重置密码；成功后 `tokenVersion+1` 吊销旧会话）。
- 下线（410）：`POST /api/register`、`POST /api/forgot-password`、`POST /api/reset-password`。
- 收紧：`POST /api/login` 仅允许无手机号的遗留账号（初始管理员 `admin`）密码登录，手机号账号一律 403。
- 数据：新增 `sms_codes` 表，只存 `sha256(phone:purpose:code:盐)`，5 分钟过期、最多 5 次尝试、用后置 `usedAt`。
- 修复：未同意协议时先判协议再消费验证码，避免「忘勾协议 → 码被烧 → 等 60 秒」。
- 前端：登录页改为三种模式（验证码登录 / 忘记密码 / 管理员登录）；`SMS_PROVIDER=mock` 时开发环境直接回显验证码便于联调。

升级：`pnpm exec prisma generate` → `pnpm run db:push` → `pnpm run db:check`。生产必须配 `SMS_PROVIDER=aliyun` + 阿里云 AccessKey/签名/模板，否则验证码只写日志、用户收不到。

---

### 一致性审计降本与可靠性（2026-10-19 追加）

- **审计分组上限跟随模型上下文**：分组字数上限不再写死 30 万，按 `context_length_limit × 0.5` 动态计算（clamp 2 万~30 万，非法回退 30 万）。16 万字文档 + 128k 上下文模型 → 自动拆 3+ 组逐组审计，替代此前"整篇一次调用"。
- **审计失败显式降级**：某组审计失败不再被静默当作「无冲突」——失败组计数、`audit_degraded`/`audit_failed_groups` 统计、任务最终状态携带 `degraded: true`，日志明示「本次结果不可信，请重试或改用 Agent 深度修复」。
- **一致性修复默认改为普通模式**：Agent 模式（100 轮次烧 837 万输入 token 的长会话）降为可选「深度修复（高消耗）」；普通修复（逐节小上下文）成为默认，token 消耗约为其零头。原方案覆盖修复模式同步调整。
- 影响文件：`server/src/tasks/utils/contentGenerationHelpers.ts`、`server/src/tasks/runners/content-generation.ts`、`client/src/features/technical-plan/pages/ContentEditPage.tsx`。新增测试：auditGroup 5 用例。

## [未发布] - 2026-10-18 · 第六批（自动配图——插图管线恢复）

### 功能

- **自动配图（插图管线恢复，product_mvp 待办）**：正文生成完成后新增「自动配图」阶段——AI 规划（挑选适合配图的流程/架构/组网/时序类小节，单文档上限 12 张，默认 6）→ 调用**生图模型**逐张生成商务扁平风示意图 → 插入对应小节首段之后，导出 Word 时嵌入原图。
- 生成配置弹窗新增「自动配图」数量输入（沿用前端既有字段 maxAiImages，0=关闭；默认 6）；配图 Markdown 不计入字数与扣费（字数口径剥离图片语法）；单图失败仅跳过不阻断任务；支持暂停/继续。
- 依赖：设置 → 生图模型 需配置 OpenAI 兼容生图服务商（Google 生图暂不支持自动配图）；图片渲染需部署环境可访问生图服务返回的图片 URL。
- 影响文件：`server/src/ai/service.ts`（新增 generateImage）、`server/src/tasks/utils/illustrationPipeline.ts(+test)`、`server/src/tasks/runners/content-generation.ts`、`server/src/tasks/types.ts`、`server/src/tasks/service.ts`、`client/src/features/technical-plan/pages/ContentEditPage.tsx`。新增测试：illustrationPipeline 4 用例（规划解析/插入位置/空正文/提示词）。

### AI 调用统计多维度面板（追加）

- **按项目统计**（含项目名、文本/生图 token 分离）
- **每日 Token 趋势**（按日期条形图，直观展示使用峰值）
- **按模型统计**（哪些模型消耗 token 最多）
- **按服务商统计**（哪些平台分摊了最多的调用）
- 影响文件：`server/src/routes/stats.ts`、`client/src/shared/api/stats.ts`、`client/src/features/settings/components/AiUsagePanel.tsx`

## [未发布] - 2026-10-18 · 第五批（字数口径统一——计费关键修复）

### 字数口径（涉及付费）

- **问题**：全站存在三套字数统计——任务/仪表盘显示用「中文逐字、英文按词」（如 162,887），导出扣费用「剥 Markdown 后逐字符、含标点与英文字母」（如 179,979），前端编辑器还有第三套。同一文档显示与扣费相差可达 **10%**，直接引发计费纠纷。
- **统一**：新建全站唯一字数模块 server/src/utils/textCount.ts（剥 Markdown 语法与围栏代码块、去全部空白、**逐字符**计数，≈Word「字符数(不计空格)」），四处全部对齐：
  1. 导出扣费（原实现，口径不变）；
  2. 任务统计/仪表盘字数（contentGenerationHelpers.countContentWords）；
  3. 字数预算校验（最低/最高/每节字数）；
  4. 前端编辑器字数显示（client wordCount.ts，改后逐字符）。
- **口径含义（用户须知）**：字数 = 去除 Markdown 符号、代码块（Mermaid 不计费）与空白后的**字符数**，含标点与英文字母；因此与 Word 的「字数」（英文按词）有差异，与「字符数(不计空格)」基本一致。
- **存量数据**：此前已完成任务的统计数字为旧口径历史值，不追溯；重新生成的项目全部按新口径。
- 影响文件：新增 server/src/utils/textCount.ts(+test)；server/src/quota/service.ts、server/src/tasks/utils/contentGenerationHelpers.ts、client/src/shared/utils/wordCount.ts。新增测试：textCount 4 用例。

## [未发布] - 2026-10-18 · 第四批（营销与登录合一 + 域名形态定稿）

### 功能与修复（后续追加）

- **登录即注册（autoRegister）**：登录接口新增显式 `autoRegister` 标记——未注册手机号登录时自动创建账号并登录（注册即送 10 万字额度、生成专属邀请码、落注册 IP/UA）。前置校验：`agree=true`（协议勾选，服务端强校验）+ 账号名必须是合法手机号（admin 等非手机号账号名永不触发自动注册）+ 密码 ≥8 位；已有账号走普通登录，密码错误不会误建号；不携带标记时行为与原先完全一致，复用登录限流。前端登录卡新增协议勾选框（未勾选提交被拦截）。影响：`server/src/routes/auth.ts`、`client/src/shared/api/auth.tsx`、`client/src/app/LoginPage.tsx`
- **导出 Word 文件名规则调整**：由「编号+项目名_时间戳.docx」改为「**{项目名}方案.docx**」；未解析到项目名称（名称为空或仍是编号占位）时直接命名「**技术方案.docx**」。不再附带编号与时间戳（同名重复导出由浏览器自动加序号）。占位判断在文件名消毒前进行（避免消毒改写字符导致占位比对失效）。影响：`server/src/export/service.ts`
- **仪表盘「类别」列**：文案改为「生成 / 扩写」短标签，渲染方式与状态列统一为格内徽标（此前是整格背景，格式不一致）；**移除「创建人」列**（个人版仅见自己项目）；**项目列表接口补返 `workflowKind`**（此前列表漏返该字段，类别恒显示「生成」）。
- **用户管理页**：列表移除「姓名」「部门」列，「字数额度」列更名「当前余额」并统一字体层级。
- **Key 池多平台支持 + 任务级平台亲和 + 条目测试**：条目格式 `Key|Base URL|模型名`，可同时挂多平台 API 轮询/冷却/故障转移；单生成任务以亲和键锁定同一条目（单文档不跨模型）；设置页新增「测试 Key 池」逐条目连通性/模型名校验（仅管理员）。冷却改指数递增（60s→10min 封顶）并遵循上游 `Retry-After`。
- 修复：项目列表接口此前漏返 `workflowKind` 导致仪表盘类别恒为「生成」；公开 `.md` 帮助文档补 charset（此前中文 Windows 下乱码）。

### 产品形态

- **「产品介绍 + 登录」合一页**：登录页左侧海报区升级为完整营销栏（`client/src/app/LoginMarketing.tsx`）——首屏价值主张、四步使用流程、六大功能矩阵、与通用 AI/人工的能力对比表、常见问题、AI 辅助免责声明。未登录打开站点即"看介绍 + 直接登录"一步完成，不再需要独立营销页与应用之间的二次跳转；登录后进入工作台，营销栏不再出现。
- 营销栏按 B 端设计 brief 重构：Hero 直击废标痛点 + 主 CTA（点击联动右侧登录卡切到注册 tab）→ 工作台界面示意（CSS 线框）→ 四步流程（线性图标+放大序号）→ 功能矩阵（**废标项检查/招标文件解析**两张王牌卡高亮，全卡可点击转化）→ 精简对比表 → 定价（真实套餐 ¥2.9/¥5/¥10/¥20）→ 适用场景 → 数据安全与合规 → FAQ（政采适配/格式合规优先）；顶部品牌条加锚点导航；卡片底色差异化（白/浅蓝），去花哨动效，免责声明保留。
- **Key 池多平台支持 + 任务级平台亲和**：Key 池条目支持 `Key|Base URL|模型名` 格式——可同时挂多个平台的 API（此前所有 Key 只能打向同一 Base URL，跨平台 Key 必然 401）；轮询全局交替分摊，某平台 401/429 冷却后流量自动落到健康平台。**任务级平台亲和**：单个生成任务以 `projectId:queueScopeId` 为亲和键稳定哈希锁定同一条目——单文档章节不跨模型生成（消除风格漂移），跨任务/跨项目仍轮换（防雷同路由）；锁定条目冷却时回退轮询（可用性优先）。
- **Key 池条目测试**：设置页新增「测试 Key 池」按钮（仅管理员），逐条目调用上游 `/models` 验证连通性、耗时，并校验条目模型名是否在上游列表中（保存前发现写错的模型名），结果含脱敏 Key、端点、耗时逐条展示。接口：`POST /ai/test-key-pool`（仅管理员）。
- 营销栏品牌名/Logo 读取管理员配置的系统名称与 Logo（`system-settings`），与登录卡一致。
- 营销栏品牌名/Logo 读取管理员配置的系统名称与 Logo（`system-settings`），与登录卡一致。
- **域名形态定稿为单域名**：`/` 直出前端 SPA（未登录=合一页，登录后=工作台）；`/docs/*`、`/agreement-*.html` 公开静态资源保留在域名根；`/api` 反代不变。放弃此前的 `/app` 子路径拆分与独立静态首页部署（`landing/index.html` 保留在仓库作为可选的纯静态 SEO 落地页，默认部署不使用）。
- 顺手修复：favicon 引用由根绝对路径改为相对路径，且 `icon_256.png` 首次进入 `public/` 构建产物（此前线上 favicon 一直 404）；营销栏「帮助文档」打开的公开 `.md` 文件补 charset——vite/nginx 此前回 `text/markdown` 无编码声明，中文 Windows 浏览器按 GBK 猜出乱码（dev 由 vite 中间件强制 `text/plain; charset=utf-8`，生产由 nginx `charset` + `charset_types` 提供）。
- 影响文件：`client/src/app/LoginPage.tsx`、新增 `client/src/app/LoginMarketing.tsx`、`client/src/styles/feature-login.css`、`client/index.html`、`client/public/icon_256.png`（新增）、`deploy/nginx/yibiao-web.conf.example`、`docs/DEPLOYMENT.md`；新增 `landing/index.html`（可选静态版，参照竞品首页骨架重写的原创文案）。

### 升级注意（部署方）

- 此前按 `/app` 子路径形态配置过 nginx 的，回退为 `/` 直出 `client/dist` 即可（新示例已更新）。
- 未配置过营销页的部署无需任何动作， nginx 保持 `try_files → /index.html` 原样即可。



### 升级注意（部署方）

- 现有部署把域名根直接指到 `client/dist` 的，绑域名前按新 nginx 示例调整：`root` 改指 `landing/` 目录并新增 `/app` location，否则根路径会继续落在应用登录页。
- `landing/` 目录需随部署同步到服务器（如 `/opt/openbidkit-yibiao-web/landing/`）。

---

## [未发布] - 2026-10-18 · 第三批（P1/P2 审计修复 + 死代码裁剪）

### 资金

- **导出计费指纹修复（双缺口）**
  - 指纹此前只哈希大纲**顶层**节点 content,而扣费字数按整棵树递归统计——"只改子节点且总字数不变"的改写会被判为同一内容而**免费导出**。现指纹与计数字口同源（`buildExportContentFingerprint` 递归整树收集）。注意:算法变更后,已导出过的内容首次再导出会正常计费一次（旧指纹不迁移）。
  - 判重补上消费流水查询:项目行指纹是"单槽位",只记住上一次计费内容,A→B→A 来回导出比对会被重复扣费。现在事务内先查 `quota_consume_logs` 是否已有 (userId, fingerprint) 流水,有即免费——兑现"同内容不重复扣费"的宣称语义。
  - 影响文件:`server/src/quota/service.ts`、`server/src/routes/export.ts`、`server/src/routes/quota.ts`

- **管理员额度调整并发安全**:原实现读-算-写整值覆盖,与并发导出扣减交错时会把扣费整个吞掉。"增减"改为条件原子 increment/decrement（负向扣到 0 为底）,"设为"改为 CAS 循环;返回值以落库后实际余额为准。入参上限 20 亿字（int4 边界,超限原为 500 现为 400）。
  - 影响文件:`server/src/quota/service.ts`、`server/src/routes/quota.ts`

- **返利流水并入核验事务**:原实现返利在事务外 best-effort,事务提交后、返利写入前若进程崩溃/DB 抖动,该笔返利静默丢失且重试核验在 paid 早退处永不补建。现「改状态+加额度+返利」三者同事务,任一失败整体回滚可重试;已 paid 的早退分支也会幂等补跑一次返利结算,修复历史遗漏。
- **返利金额整数分运算**:`floor(实付分 × 比例% / 100)` 后再转元,消除浮点除法在 x.xx5 边界的舍入方向漂移;冻结周期配置上限 3650 天。
- **自邀启发式拦截（DB-22 一期）**:核验时发现被邀请人与邀请人**注册 IP 相同** → 跳过返利并告警。完整反作弊（设备指纹/活跃 IP）仍按 product_mvp 留待二期支付上线前。
  - 影响文件:`server/src/quota/service.ts`

- **订单核验补审计**:核验入账（含重复核验早退）写入 `admin_audit_logs`（action=`quota.order.paid`,含订单号/字数/金额/操作人）,此前这一资金操作无任何留痕。
  - 影响文件:`server/src/routes/quota.ts`、`server/src/audit/service.ts`

### 安全 / 稳定性

- **查重选文件内存防护**:`collectRawUploads` 新增单请求 ≤20 文件 / ≤200MB 上限,`/duplicate-check/select-files` 挂 10 次/分限流——此前单请求 30×100MB 全量堆内存即可 OOM 杀进程（单实例部署 = 全站不可用）。
- **废标检查导入限流**:`/rejection-check/import-document` 补 20 次/分限流（对齐 technical-plan 同类接口）。
- **AI 错误弹窗投递校验**:`/api/ai/*` 的 `X-Project-Id` 头现在会校验项目归属后才向该项目 SSE 通道 fan-out 上游错误——此前任何登录用户可借伪造头向他人项目投递自定义错误弹窗（钓鱼面）。顺带修复:该戳此前存 string 导致 AI 代理路由的 `AiCallStat.projectId` 恒为 null,现已按 number 落值。
- **analytics/visit 令牌校验收紧**:改用 `verifyAccessToken`（拒绝 initial-password-change 用途令牌）+ 回查 tokenVersion,已改密/吊销的旧 token 不再被归因到用户。
- **图片查重移除 `file://` 分支**:`readImageTargetBuffer` 不再按客户端给的任意本地路径读文件（原构成任意路径哈希 oracle）;web 版图片一律 data: URL。
  - 影响文件:`server/src/document/multipart.ts`、`server/src/routes/duplicate-check.ts`、`server/src/routes/rejection-check.ts`、`server/src/routes/ai.ts`、`server/src/routes/analytics.ts`、`server/src/tasks/utils/duplicateAnalysisHelpers.ts`

### 死代码裁剪（API-21 收尾）

- 服务端物理删除:`routes/asset-library.ts` + `src/asset-library/`、`routes/personnel.ts` + `src/personnel/`、`routes/knowledge-base.ts`（均已停止注册、零引用）。注意 `src/knowledge-base/store.ts` **保留**——content-generation/global-facts runner 仍用它读共享工作区文档,是活代码。
- 客户端物理删除:`features/knowledge-base/`、`features/asset-library/`、`features/personnel/`、`shared/api/knowledge-base.ts` 及对应 3 个 CSS;`bridge.ts`/`types/ipc.ts` 移除 knowledgeBase 命名空间。
- 删除无调用方的死函数:`chargeExportQuota`、`recordQuotaConsumeLog`。
- **客户端 tsc 基线清零（6 → 0）**:修复 `types/ipc.ts` 对 web 桥接的类型漂移（config.savePlatform/saveUser、templates.create isShared/setShared 缺失）及 GlobalFactsPage/MyTemplatesPage/SettingsPage 三处调用点空值收紧。服务端 tsc 201 → **159**,余量全部位于活代码（knowledge-base/store 102、duplicate-analysis 26、docxBuilder 9 等）,属后续类型债批次,非死代码。

### 前端

- **FE-12 AI 质检免责声明**:废标项检查、标书查重页面顶部新增显著横幅——"AI 检查结果仅供参考,可能存在遗漏或误判,不能替代人工审核"。
- **FE-08 补口**:设置页「基本设置」tab 仅管理员可见（此前普通用户能看到并编辑系统名称/Logo 表单,保存必 403;误入自动回落到「通用」tab）。
  - 影响文件:`client/src/shared/ui/AiCheckDisclaimer.tsx`、查重/废标两页、`client/src/features/settings/pages/SettingsPage.tsx`

### 接口行为变化（部署方注意）

| 变更 | 说明 |
| --- | --- |
| 导出计费指纹算法变更 | 已导出内容首次再导出会正常计费一次 |
| 同内容 A→B→A 重复导出 | 不再重复扣费（查消费流水判重） |
| `/quota/adjust` | setChars/deltaChars 超过 20 亿字返回 400（原 500）;`freezeDays` 上限 3650 |
| 订单核验 | 写入管理员审计日志;历史"已入账但返利丢失"的订单重复核验会幂等补建返利 |
| 自邀注册 IP 相同的邀请关系 | 核验时跳过返利生成 |
| `/duplicate-check/select-files` | 新增 10 次/分限流、20 文件/200MB 上限（超出部分忽略并记入 errors） |
| `/rejection-check/import-document` | 新增 20 次/分限流 |
| `/api/ai/*` | `X-Project-Id` 伪造他人项目时不再投递错误弹窗;AiCallStat.projectId 开始落值 |

### 静态检查

- 客户端 `tsc --noEmit` **0 错误**;`vite build` 通过。
- 服务端 `tsc --noEmit` 193 → **159**（删除死模块带走 34）,余量在活代码文件,本轮改动文件 0 新增错误。

### 复核补充（同批自审发现）

- **正文图表主动生成（竞品对标：小晓/喜鹊的图表能力）**：正文编排引入与表格同模式的 **Mermaid 图表编排**——计划阶段按小节内容判断是否适合配示意图（流程/组网/时序），全文预算默认 `light`（叶子小节数 ×10%，接受 `chart_requirement` none/light/moderate/heavy 覆盖），全局分布式择优、超限降级为纯文字。生成提示词在图表命中时放开 Mermaid 禁令并施加语法约束（仅 flowchart TD / sequenceDiagram、节点 ≤12、节点文字禁特殊字符），导出与客户端预览渲染链路零改动（mermaid.ink 渲染已存在）；`countContentWords` 剥离围栏代码块，图表文字不计入正文字数与导出计费口径。影响：`server/src/tasks/utils/contentGenerationHelpers.ts`、`server/src/tasks/runners/content-generation.ts`
- **安全响应头**：服务端 `onRequest` 钩子统一加 `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: strict-origin-when-cross-origin`,HSTS 仅在 HTTPS 请求上发送；nginx 示例同步补静态资源侧同名头(完整 CSP 涉及内联样式与 mermaid/blob 策略,仍留待单独批次)。影响:`server/src/index.ts`、`deploy/nginx/yibiao-web.conf.example`
- **额度调整审计补漏**：delta 分支在"增减已落库、但实际净变化被并发导出恰好抵消为 0"时,原实现会按"调整前后余额相同"早退——调整实际生效却无审计留痕、管理员还看到失败。已移除该早退,净变化为 0 也落一条 delta=0 的审计记录。
- 删除新死代码 `deductQuotaChars`（唯一调用方 `chargeExportQuota` 已删）；`/duplicate-check/select-files` 部分成功时(触发文件数/总字节上限)把忽略原因带进 message,不再静默丢文件。

---

## [未发布] - 2026-10-18 · 第二批（P0 审计修复）

本批来自一次资金链路 + 数据隔离的代码审计,处理其中 P0 三项。

### 安全

- **`/api/ai/list-models`、`/api/ai/test-image-model` 增加管理员门禁**
  - 这两个"连通性测试"接口接受客户端传入任意 `base_url` 并由服务端发起请求,且上游非 2xx 时错误响应体原文回显——此前任何登录用户可将其当作带回显的内网 SSRF 探测通道。
  - 现仅管理员可达(功能本就只属于管理员设置页);项目已有的 `assertPublicHttpUrl` 防护(`export/images.ts`)不强行套用,避免破坏文档明确支持的内网/本地模型网关部署形态。
  - 影响文件:`server/src/routes/ai.ts`

- **`/api/ai/chat`、`/api/ai/request-json` 增加 AI 代理输入闸与输出钳制**
  - 此前任意自助注册用户可用平台 key 零成本转发任意 `messages`(仅 30 次/分限流,输入无上限、`max_tokens` 不钳制),脚本化刷量可直接烧平台 token(CHANGELOG 上一批"已知遗留"第 2 条)。
  - 现在:输入超 5 万字直接 400;`max_tokens` 统一钳制 ≤ 8192(未传时也显式封顶)。
  - 服务端任务 runner(招标解析/目录/正文生成等大上下文链路)走 tasks 引擎内部 aiService,不经过该代理,不受影响。
  - 影响文件:`server/src/routes/ai.ts`

### 功能移除

- **响应偏离表工作台物理下线**（product_mvp DB-01/FE-01）
  - 该模块的 Prisma 模型已随 DB-01 从 schema 删除,但路由、任务与 runner 仍在注册——任何触达都会抛 `TypeError: prisma.responseDeviationWorkspace is undefined`(500),与上一批下线的知识库路由同一病灶,当时漏掉了它。技术方案首页与导出成功弹窗还会主动调用 availability 接口,持续制造 500 与错误日志噪音。
  - 服务端:摘除 `/api/response-deviation*` 路由注册、`POST /api/tasks/start-response-deviation-generation`、runner 注册,以及 TaskService 的 `responseDeviationStore` / `tenderSourceService` 依赖、崩溃恢复分支与快照分支;物理删除 `server/src/response-deviation/`、`server/src/routes/response-deviation.ts(.test.ts)`、`tasks/runners/response-deviation-generation.ts(.test.ts)`。
  - 客户端:移除 `AppRouter` 路由 case、`TechnicalPlanHome` 的 availability 拉取与导出后"进入偏离表工作台"引导卡;`RETIRED_SECTIONS` 新增 `response-deviation-table`,旧书签/直链兜底重定向仪表盘;物理删除 `client/src/features/response-deviation/`、`shared/api/response-deviation.ts`、`styles/feature-response-deviation.css`,并清掉 `export-response-next-card` 死样式(客户端 tsc 基线错误 7 → 6,第 7 个恰在被删文件中)。

### 接口行为变化（部署方注意）

| 变更 | 说明 |
| --- | --- |
| `POST /api/ai/chat`、`/api/ai/request-json` | 输入 > 5 万字返回 400;`max_tokens` 钳制 ≤ 8192 |
| `POST /api/ai/list-models`、`/api/ai/test-image-model` | 非管理员返回 403（原任何登录用户可调用） |
| `/api/response-deviation*`、`POST /api/tasks/start-response-deviation-generation` | 已移除，返回 404 |
| 技术方案导出成功弹窗 | 不再出现"进入偏离表工作台"引导卡 |

### 静态检查

- 客户端 `tsc --noEmit` 7 个既有基线错误不变,本轮改动文件 0 错误;`vite build` 通过。
- 服务端 `tsc --noEmit` 由约 201 个基线错误降至 193(删除的 response-deviation 文件带走 8 个),本轮改动文件 0 错误,余量全部位于已知死模块/基线文件。

---

## [未发布] - 2026-10-18

本轮改动来自一次完整的代码审查 + 本地端到端联调（约 110 个接口断言）。
按「安全 → 资金 → 功能缺陷 → 工程化」排列。

### 安全

- **找回密码不再回显改密凭证**
  - `MAIL_DEV_MODE` 默认值由 `true` 改为 `false`；`NODE_ENV=production` 时强制失效，即使环境变量误配也不生效。
  - `/api/forgot-password` 在生产语义下不再返回 `devResetUrl`（该字段等同把一次性改密 token 直接交给调用方，谁都能凭邮箱接管账号）。
  - 非开发模式下响应文案改为「当前系统未启用邮件投递，请联系管理员重置密码」，不再谎报「链接已发送」。文案只取决于部署配置、与邮箱是否注册无关，不引入邮箱枚举。
  - 影响文件：`server/src/auth/mailer.ts`、`server/src/routes/auth.ts`、`server/.env.example`

- **Markdown 渲染的存储型 XSS**
  - 原始 HTML 不经过 markdown-it 的 `validateLink`，`<a href="javascript:...">` 会被原样渲染成可点击链接；本项目 token 存 localStorage，中招即完整账号接管。
  - 新增 `isSafeLinkUrl` / `isSafeImageUrl`：链接只放行 `http/https/mailto/tel` 与相对路径；图片只放行 `http/https/blob` 与 `data:image/*`；不安全协议降级为纯文本。
  - 判协议前剥离空白与控制字符（防 `java\tscript:` 绕过）；HTML 实体在 DOMParser 阶段已被解码，同样会被拦。
  - **注意**：`allowRawHtml` 的默认值保持 `true`。`.docx/.pdf` 解析会把表格以 `<table>`、换行以 `<br>` 保留，关掉会让正文表格退化成字面标签；脚本执行面已由「标签白名单 + 协议白名单」封死。
  - 影响文件：`client/src/shared/ui/MarkdownRenderer.tsx`

- **IP 限流可被伪造头绕过**
  - 原实现无条件取 `X-Forwarded-For` 第一段；nginx 用的是 `$proxy_add_x_forwarded_for`，客户端自填值就在最前，换一个头就换一个限流桶，登录爆破/注册/验证码限流与注册 IP 采集全部失效。
  - 现在：直连对端是公网地址（没有反代）时**完全忽略** XFF；对端是回环/内网时，按 `TRUSTED_PROXY_HOPS`（默认 1）从链尾倒数取值；链比配置层数还短时退回连接地址，绝不退化去信任最左段。
  - 新增环境变量 `TRUSTED_PROXY_HOPS`（Nginx 单层=1，CDN+Nginx=2）。
  - 影响文件：`server/src/auth/rateLimit.ts`、`server/.env.example`

### 资金

- **订单核销事务化**：`pending → paid` 与「给用户加额度」放进同一事务。此前状态置 paid 后若入账失败，就是钱收了额度不到账，且状态已变、重试也补不回来。返利流水仍在事务外（best-effort + 自带幂等）。
  - 影响文件：`server/src/quota/service.ts`（`markQuotaOrderPaid`）

- **导出扣费并发安全**：原实现是「读指纹 → 扣费 → 写指纹」，并发导出同一内容会各自读到空指纹、重复扣费。新增 `chargeExportOnce`，把扣额度、抢占内容指纹、写消费流水收进一个事务，用条件 `updateMany` 做并发闸门；同内容重复导出回滚扣减并跳过流水。
  - 实测：并发两次同内容导出只扣 21 字（等于单篇额度），消费流水只落 1 条。
  - 影响文件：`server/src/routes/quota.ts`（新增 `chargeExportOnce`）、`server/src/routes/export.ts`

### 功能移除

- **PDF 导出下线**（产品决策）
  - 移除 `POST /api/export/pdf`（现返回 404）、`server/src/export/pdf.ts` 实现、客户端 `exportPdf()` 与其死 import。
  - **PDF 解析能力不受影响**：`.pdf` 仍由 `pdf-parse` + `pdfjs-dist` 解析，招标文件、知识库、查重指纹、资质预览均正常。
  - 同步更新：`product_mvp.md`、`development_tasks.md`、`docs/DEPLOYMENT.md`、`client/public/agreement-user.html`、`docs/design/copywriting.md`。

- **知识库 / 资产资质库 / 人员资质库彻底下线**
  - 这三个模块的 Prisma 模型已随 DB-01~04 从 schema 删除，但服务端路由仍在注册，任何调用都会抛 `Cannot read properties of undefined`（500）。
  - 移除 `/api/knowledge-base/*`、`/api/asset-library/*`、`/api/personnel/*` 整组路由（现返回 404）。
  - 前端同步：移除「知识库」一级菜单及其四个子项、`AppRouter` 对应页面与 import、`ASSIGNABLE_MODULES` / `GRANTABLE_MODULE_IDS` / `SECTION_TO_MODULE` 中的 `knowledge-base`。
  - 新增 `RETIRED_SECTIONS` 拒绝表：旧书签/直链落到已下线 section 时由 `AppRouter` 兜底重定向到仪表盘，而不是白屏。
  - 影响文件：`server/src/index.ts`、`server/src/auth/permissions.ts`、`client/src/app/menuConfig.ts`、`client/src/app/AppRouter.tsx`、`client/src/shared/permissions.ts`

### 缺陷修复

- **删过项目后新建项目 500**：`projectCode` 原本用 `count + 1` 生成，删掉中间项目后编号会与现存编号撞上 `@@unique([ownerId, projectCode])`。改为取「当年已有最大序号 + 1」，并对并发撞号做 P2002 重试（最多 5 次），耗尽后返回 409 而不是把 Prisma 原始错误抛成 500。
  - 实测：建 3 个 → 删中间 → 新建拿到 `XM2026-0004`。
  - 影响文件：`server/src/routes/projects.ts`

- **任务引擎收尾可能崩进程 + 组锁永久卡死**：fire-and-forget 链是 `then(runner).catch(错误落库).then(清理)`，若「错误态落库」本身抛错（DB 抖动），后续 `then` 被跳过——既留下未处理的 rejection（Node 默认抛错杀进程），又不释放任务组锁，该组之后所有 `start-*` 都 409 直到重启。已把清理抽成 `releaseTaskSlot()` 挂到链尾 `.finally()`，并补末端 `.catch()` 只记日志。
  - 影响文件：`server/src/tasks/service.ts`

- **Vite dev server 因临时文件崩溃**：编辑器/工具原子写入会在源码目录留下 `.xxx.tmpdir/`，被 watch 到并抛 `EBUSY` 后 dev server 直接退出。已加 `server.watch.ignored`。
  - 影响文件：`client/vite.config.ts`

- **pnpm 10/11 装不上依赖**：`pnpm-workspace.yaml` 里是 pnpm 生成的占位符 `set this to true or false`，导致 `ERR_PNPM_IGNORED_BUILDS` 且 `pnpm exec` / `pnpm run` 直接中断。改为真布尔值后 `pnpm install` 退出码 0。
  - `better-sqlite3` 置 `false`：Node 24 无预编译包、需要 node-gyp 本地编译；它只被 `agent/runtimeService.ts` 动态 import 且失败即整块降级，不影响主服务与任务执行。部署环境若有 VS Build Tools 可改回 `true`。
  - 影响文件：`server/pnpm-workspace.yaml`、`client/pnpm-workspace.yaml`

### 数据库

- 修复 schema 漂移：线上库的 `projects` 表仍是 **`projectCode` 全局唯一**，而 `schema.prisma` 声明的是 `@@unique([ownerId, projectCode])`。这会让**第二个用户建项目必然撞号**（每个用户都从 `XM2026-0001` 开始）。
  - 已执行：
    ```sql
    DROP INDEX "projects_projectCode_key";
    CREATE UNIQUE INDEX "projects_ownerId_projectCode_key" ON "projects"("ownerId","projectCode");
    ```
  - 根因是仓库没有 `prisma/migrations`，只靠 `prisma db push`，漏推一次就会静默漂移。

### 工程化

- 新增 `pnpm run db:check`：对比「数据库实际结构」与 `schema.prisma`，有漂移就打印差异 SQL 并以非 0 退出。升级代码后必须跑一次。
- 新增 `pnpm run db:push` 作为 `prisma db push` 的简写。
- `README.md`：补充 `db:check` 步骤与漂移后果说明；纠正 LibreOffice 说明——`.docx`（mammoth）、`.pdf`（pdfjs）、`.xlsx`（SheetJS）均由纯 JS 解析，**只有 `.doc` / `.wps` 这类老格式需要 LibreOffice**。
- `server/.env.example`：补充 `TRUSTED_PROXY_HOPS`、`MAIL_DEV_MODE`、`WEB_BASE_URL` 三个变量的说明。

### 接口行为变化（部署方注意）

| 变更 | 说明 |
| --- | --- |
| `POST /api/export/pdf` | 已移除，返回 404 |
| `GET /api/knowledge-base*`、`/api/asset-library*`、`/api/personnel*` | 已移除，返回 404（原为 500） |
| `POST /api/projects` 编号冲突 | 返回 409（原为 500） |
| `POST /api/forgot-password` | 非开发模式不再返回 `devResetUrl`，`message` 文案变化（前端按 message 展示，无需改造） |
| 用户 `modules` 中的 `knowledge-base` | 新代码会过滤掉该值，已授予用户自动失效 |
| 新建项目编号 | 同一用户同一年内按「最大序号 + 1」递增，删除项目后不会复用旧编号 |

### 升级步骤

```powershell
cd server
pnpm install              # 需要跑 prisma/esbuild 构建脚本
pnpm exec prisma generate
pnpm run db:check         # 有输出说明库结构漂移，按输出 SQL 处理
# 本次关键变更：projects 唯一索引（见上方「数据库」）
pnpm run dev
```

可选环境变量（生产建议）：

```dotenv
CORS_ORIGINS=https://your-domain.com
CONFIG_ENCRYPTION_KEY=<长随机串>
MAIL_DEV_MODE=false
TRUSTED_PROXY_HOPS=1
WEB_BASE_URL=https://your-domain.com
```

### 测试记录（本地联调，2026-10-18）

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| 普通用户 E2E | 42/42 | 登录/验证码、项目 CRUD、技术方案、任务列表、配额、邀请、AI 用量、配置脱敏、模板、模块门禁、Word 导出、SSE |
| 管理员 E2E | 40/40 | 用户管理、平台配置、基本设置、提示词、文档、FAQ、分析看板、订单核销、额度调整、返利配置、AI 诊断 |
| 模块门禁 | 7/7 | 授予后放行、未授予 403、已下线模块 404 |
| 计费并发 | 8/9（失败项为测试脚本未取二进制响应，导出本身 200 且已计费） | 并发同内容只扣一次、重发不扣、重复核销幂等、流水条数一致 |
| 额度边界 | 5/5 | 余额 0 → 402 + `QUOTA_INSUFFICIENT` + 套餐列表 |
| 邀请返利 | 8/8 | 邀请码注册 → 下单 → 核验 → 冻结返利 40% |
| AI + 任务引擎 | 通过 | `/ai/chat` 200、招标解析任务 success、SSE 14 帧、埋点 6 次调用、正文落库 |
| 文档解析 | 通过 | `.docx` 上传 → 200，表格转 `<table>` |

静态检查：`tsc --noEmit` 客户端 7 个、服务端 201 个**既有**错误（集中在待裁剪模块），本轮改动文件 0 错误。

### 已知遗留（未在本轮处理）

1. **图形验证码可被脚本解析**：字符以 `<text>X</text>` 直接写在 SVG 里，正则即可还原（联调时即以此登录）。真正修复需改为路径/位图渲染或接入短信、行为验证码。
2. **AI 调用不计费**：`POST /api/ai/chat` 用平台 key 转发任意 `messages`，仅受 30 次/分/人限制，不扣字数额度；当前计费只发生在导出环节。
3. **管理员可读写所有用户项目**：项目级校验均为 `ownerId !== user.id && role !== 'admin'`。属运营策略问题，若保留建议补审计。
4. **无 `prisma/migrations` 基线**：只有 `db push` + 本轮的 `db:check` 兜底，历史漂移仍需人工确认。
5. **死模块代码仍在**（`server/src/asset-library`、`server/src/personnel`、`client/src/features/knowledge-base` 等）：已不被路由引用，但仍参与编译；建议连同 KB 相关的 runner 分支一起裁剪。
6. **无 CSP / 安全响应头**：`index.ts` 未注册 helmet，nginx 示例也未配置 HSTS / X-Frame-Options / nosniff。
7. **OpenCode sidecar 降级**：缺 `rg` / `fd` / `jq`，且 `better-sqlite3` 未编译，事件轮询降级为 no-op；主流程不受影响。
