# 两份代码的差异清单（Desktop 副本 vs DSH 副本）

生成时间：2026-10-20 01:20
用途：确认「VS Code 里改过、到 DSH 又出现」的原因，并为后续合并提供清单。**本次不合并代码。**

---

## 0. 结论（先看这段）

**不是 DSH 把你的修复改回去了，而是 DSH 一直在改另一份代码。**

- 你在 VS Code 里改的是：`C:\Users\22722\Desktop\投好标\OpenBidKit-Yibiao-Web-main`
  - 远端：`github.com/shalishali/OpenBidKit-Yibiao-Web-main`
  - 最新提交：`6bc4189`（2026-10-18 03:09），共 **61** 个提交
- DSH 一直在改的是：`D:\THB\THB-20261018`
  - 远端：`github.com/shalishali/THB-20261018`
  - 最新提交：`054b0c7`（2026-10-20 00:18），共 **21** 个提交（1 个初始导入 + 本周 20 个修复）

两份代码是**独立演化**的：DSH 那份初始导入时只有 1 个 squash 提交，没有 Desktop 的 61 条历史，所以 Desktop 后续的修复无法自动带过来；反过来 DSH 本周的新功能也不在 Desktop 里。

已确认因此重复出现的问题：
1. 导出重复扣费（DSH 侧重新引入了回归，已于 `054b0c7` 修复）
2. STEP02 项目名回填（DSH 侧是另一套旧逻辑，已于 `18e05d6` 修复）

---

## 1. 仓库元信息

| | Desktop（VS Code） | DSH |
| --- | --- | --- |
| 路径 | `C:\Users\22722\Desktop\投好标\OpenBidKit-Yibiao-Web-main` | `D:\THB\THB-20261018` |
| 远端 | `shalishali/OpenBidKit-Yibiao-Web-main` | `shalishali/THB-20261018` |
| HEAD | `6bc4189` 2026-10-18 03:09 | `054b0c7` 2026-10-20 00:18 |
| 提交数 | 61 | 21 |
| 工作区 | 2 个未提交（`client/server pnpm-workspace.yaml`） | 干净 |
| 特征 | 有 KB/资产/人员/响应偏离文件（但 schema 模型已删）、有 /export/pdf 路由、无短信登录、无 E2E/CI | 已清理死模块、短信登录、安全加固、E2E/CI、依赖升级 |

> 注意：DSH 的 `server/.env` 里 `YIBIAO_DATA_DIR` 指向 Desktop 目录 —— **数据库/数据是同一份，代码是两份**，更容易混淆。

---

## 2. 文件级差异

共比较：server/src、client/src、server/prisma、deploy、docs、.github、e2e、根目录关键文件。

| 类别 | 数量 |
| --- | --- |
| Desktop 文件总数 | 387 |
| DSH 文件总数 | 355 |
| 仅 Desktop 有 | 56 |
| 仅 DSH 有 | 24 |
| 两边都有但内容不同 | 117 |

### 2.1 仅 Desktop 有（56 个，全部是已删模型的遗留模块）

- server/src（33）：`knowledge-base/` 6 个、`response-deviation/` 13 个、`asset-library/` 2 个、`personnel/` 1 个、`routes/` 5 个、`tasks/runners/response-deviation-generation*` 2 个、其它 4 个
- client/src（23）：`features/asset-library` 5、`features/personnel` 6、`features/knowledge-base` 2、`features/response-deviation` 4、`shared/api` 2、`styles` 4

**这些不是 DSH 丢的功能**：Desktop 自己的提交 `2dbb144` 已经把 Prisma 模型删了（`schema.prisma` 里搜不到 KnowledgeBase/Asset/Personnel/ResponseDeviation），但文件、菜单、权限、路由注册还留着 —— 点进去会调用不存在的 Prisma 模型而 500。DSH 是把这套死代码/死菜单彻底删干净了。

### 2.2 仅 DSH 有（24 个，本周新增）

- 短信登录：`server/src/auth/sms.ts`
- 统一字数：`server/src/utils/textCount.ts` + 测试
- 自动配图管线：`server/src/tasks/utils/illustrationPipeline.ts` + 测试
- 安全/配额/导出回归测试：`config/store.test.ts`、`quota/fingerprint.test.ts`、`routes/ai.test.ts`、`bid-analysis.test.ts`、`contentGenerationHelpers.auditGroup.test.ts`
- E2E：`e2e/`（Playwright 7 条）
- CI：`.github/workflows/ci.yml`
- 文档：`AGENTS.md`、`CHANGELOG.md`、`docs/design/competitor-analysis-2026-10.md`
- 客户端：`LoginMarketing.tsx`、`queryClient.ts`、`AiCheckDisclaimer.tsx`

### 2.3 两边都有但实现不同（117 个）

集中在：

- `client/src`（57）：登录页/auth、Dashboard、AppRouter、侧栏、Settings、TechnicalPlanHome、MarkdownRenderer、http/sse、样式
- `server/src`（50）：auth、projects、export、quota、config、tasks、ai、index
- 其它：`server/prisma/schema.prisma`（DSH 多了 `SmsCode` 等）、`README/DEPLOYMENT/nginx`、`.gitignore`

重点文件：`client/src/app/LoginPage.tsx`、`client/src/shared/api/auth.tsx`、`server/src/routes/auth.ts`、`server/src/routes/export.ts`、`server/src/quota/service.ts`、`server/src/routes/projects.ts`、`server/src/index.ts`、`client/src/features/dashboard/pages/DashboardPage.tsx`、`client/src/features/settings/pages/SettingsPage.tsx`。

---

## 3. 功能/修复对照矩阵

✅ 已有等价实现；⚠️ 实现不同；❌ 缺失。

| 项目 | Desktop | DSH | 说明 |
| --- | --- | --- | --- |
| 项目名 STEP02 回填 | ✅ `1678115` | ✅ `18e05d6` | DSH 额外支持 JSON `project_name`（Desktop 只匹配中文行） |
| 项目编号按用户隔离 | ✅ `5d57da2` | ✅ | 两边都有 `ownerId+projectCode` 唯一 + max+1 |
| 仪表盘「类别」列 | ✅ `adeb410` | ✅ | 两边都有 |
| 表头列顺序/对齐 | ✅ `6bc4189` | ✅ | DSH 用表头内边距对齐徽标文字；实现不同 |
| 第 5 点新建守卫 | ⚠️ 仍按「有未完成项目」拦 | ⚠️ 改为「生成中才拦」 | DSH 符合你最新的要求；Desktop 仍是旧逻辑 |
| 空项目自动清理已移除 | ✅ `ca07964` | ✅ | 两边都无相关代码 |
| 工作流切换不弹确认 | ✅ `0099128` | ✅ | 两边都无确认框 |
| 导出字数口径 | ✅ `ec551e4` | ✅ | DSH 统一到 `utils/textCount.ts`，且围栏代码计入 |
| PDF 导出下线 | ❌ 仍有 `/export/pdf` + `export/pdf.ts` | ✅ 路由已删，仅保留 PDF 解析输入 | 你之前说「PDF 导出不需要」，DSH 已执行 |
| 知识库/资产/人员/响应偏离 | ⚠️ 文件/菜单/路由都在，但模型已删（死功能） | ✅ 已彻底删除 | DSH 更干净 |
| 短信验证码登录 | ❌ | ✅ | DSH 本周新增 |
| 验证码位图（防脚本读答案） | ❌ SVG 明文 | ✅ PNG | DSH 本周新增 |
| AI 代理仅管理员 | ❌ | ✅ | DSH 本周新增 |
| 配置写接口脱敏 | ❌ | ✅ | DSH 本周新增（P0） |
| CORS 生产 fail-fast / CSP | ❌ | ✅ | DSH 本周新增 |
| 导出重复扣费去重 | ⚠️ 仅项目级指纹 | ✅ 内容指纹 + 消费流水 + 旧指纹兼容 | DSH 本周修复 |
| 导出 Mermaid 本地渲染 | ❌ 逐张联网 mermaid.ink | ✅ 浏览器预渲染 + 服务端兜底 | 实测 15.2s → 0.19s |
| E2E + CI | ❌ | ✅ | 7 条 E2E + 全量单测 |
| 依赖安全升级 | ❌ 旧版本 | ✅ fastify 5.12.7 / pdfjs 6.4.299 / xlsx 0.20.3 / adm-zip 0.6.1 等 | DSH 本周 |
| 每人限 1 个正文任务 / 落库 10s / 排队位次 | ❌ | ✅ | DSH 本周 |
| Agent 状态脱敏 / 配额溢出 / SSE 重试 | ❌ | ✅ | DSH 本周 |

---

## 4. Desktop 提交逐条对照（近 20 条）

> 只对已人工核对的做结论；标「未核对」的需要再逐条看 diff。

| Desktop 提交 | 内容 | DSH 状态 |
| --- | --- | --- |
| `6bc4189` | 表头列顺序与数据列对齐 | ✅ 已用 CSS 内边距实现 |
| `adeb410` | 仪表盘新增类别列 | ✅ 有 |
| `1678115` | 名称回填作用域修复 | ✅ 有，且支持 JSON |
| `ca07964` | 移除空项目自动清理 | ✅ 无相关代码 |
| `5d57da2` | 项目编号按用户隔离 | ✅ 有 |
| `0099128` | 工作流切换不弹确认 | ✅ 无确认框 |
| `0f1ca66` | 快速创建项目未上传文件时清理空项目 | ✅ 无相关代码（随 ca07964） |
| `51ac78e` | 修复守卫移除后残留大括号 | ✅ 无该问题 |
| `5711291` | 移除第5点守卫 + 自动建项目 + 类别 | ⚠️ DSH 保留守卫但改为「生成中才拦」 |
| `9f0e9a6` | 登录海报去 PDF 描述 | ✅ DSH 已重写登录营销页 |
| `c98f837` | 清理产品/营销 PDF 残留 | ✅ DSH 仅保留「PDF 可解析」说明 |
| `5d826ac` | 屏蔽 PDF 导出入口 | ✅ DSH 已删路由 |
| `ec551e4` | 导出计费字数口径 | ✅ 统一 textCount |
| `f091391` | 导出预检改用充值弹窗 | ✅ DSH 有 QUOTA_INSUFFICIENT 流程 |
| `01614f4` | 额度不足提示条 | ✅ 保留 |
| `ff2cea2` | 数据看板允许纵向滚动 | 未核对（DSH 样式有改动，需目视） |
| `ac4a511` | 侧栏允许纵向滚动 | 未核对（同上） |
| `d75ff8b`/`dab6c1f` | 报错管理/数据看板/客服/文案 | 未核对（DSH 有 errorlog/analytics，需逐页对比） |
| `013be2f` | PDF 转换 LibreOffice 多路径 | ✅ DSH 解析模块已多路径（PDF 导出已删） |

---

## 5. DSH 本周独有成果（16~18 批，详见 CHANGELOG）

短信验证码登录、验证码位图化、导出计费去重与预检、Mermaid 本地渲染、安全 P0/P1 加固（配置脱敏、AI 门禁、CORS/CSP、任务锁、清空项目守卫、短信原子计数、手机号定位）、依赖安全升级、路由懒加载（1.1MB→361KB）、STEP02 名称回填、仪表盘口径、创建人列、每人 1 任务、落库 10s、排队位次、E2E/CI。

---

## 6. 建议（等你决定）

1. **推荐以 DSH（THB-20261018）为唯一主线**：它没有死模块、含短信登录与全部安全修复、有测试和 CI；把 Desktop 里 DSH 仍缺的 UI 细节（滚动修复、报错管理页面差异等）逐条人工核对后移植。
2. 若必须以 Desktop 为上线主线：需要把短信登录（`SmsCode` 表 + auth 路由 + 客户端登录页）、安全加固、导出修复、依赖升级整体搬过去，工作量远大于反向移植。
3. **先冻结一份**：两边同时改会继续产生「改过又出现」。
4. 需要你确认：
   - 哪个仓库是上线/长期维护主线？
   - Desktop 的 61 条提交历史是否还需要保留（DSH 只有 1 条初始提交，无法 cherry-pick）？
   - PDF 导出是否彻底删除（DSH 已删路由；Desktop 还有 `/export/pdf`）？
   - 知识库/资产/人员/响应偏离是否确定不要（DSH 已删；Desktop 等于是死代码）？

---

## 附录 A：仅 Desktop 有的 56 个文件

（见 `/tmp` 生成清单或按目录：server/src 33、client/src 23；均为 knowledge-base / asset-library / personnel / response-deviation 及其路由、样式、测试。）

## 附录 B：仅 DSH 有的 24 个文件

`server/src/auth/sms.ts`、`server/src/utils/textCount.ts(+test)`、`server/src/tasks/utils/illustrationPipeline.ts(+test)`、`server/src/config/store.test.ts`、`server/src/quota/fingerprint.test.ts`、`server/src/routes/ai.test.ts`、`server/src/tasks/runners/bid-analysis.test.ts`、`server/src/tasks/utils/contentGenerationHelpers.auditGroup.test.ts`、`e2e/*`（8 个）、`.github/workflows/ci.yml`、`AGENTS.md`、`CHANGELOG.md`、`docs/design/competitor-analysis-2026-10.md`、`client/src/app/LoginMarketing.tsx`、`client/src/shared/api/queryClient.ts`、`client/src/shared/ui/AiCheckDisclaimer.tsx`。
