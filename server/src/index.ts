import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { authRoutes, meRoutes } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { userRoutes } from './routes/users';
import { configRoutes } from './routes/config';
import { systemSettingsPublicRoutes, systemSettingsAdminRoutes } from './routes/system-settings';
import { aiRoutes } from './routes/ai';
import { templateRoutes } from './routes/templates';
import { technicalPlanRoutes } from './routes/technical-plan';
import { duplicateCheckRoutes } from './routes/duplicate-check';
import { rejectionCheckRoutes } from './routes/rejection-check';
import { documentRoutes } from './routes/documents';
import { exportRoutes } from './routes/export';
import { eventRoutes } from './routes/events';
import { taskRoutes } from './routes/tasks';
import { feedbackRoutes } from './routes/feedback';
import { docsRoutes } from './routes/docs';
import { promptReadRoutes, promptAdminRoutes } from './routes/prompts';
import { agentRoutes } from './routes/agent';
import { createVerifyToken, createRequireAdmin, createRequireProject } from './auth/middleware';
import { getAllowedOrigins } from './auth/corsOrigin';
import { createRequireModule } from './auth/permissions';
import { getAiService } from './ai/service';
import { createTechnicalPlanStore } from './technical-plan/store';
import { createDuplicateCheckStore } from './duplicate-check/store';
import { createRejectionCheckStore } from './rejection-check/store';
// 知识库模块已整体下线（schema 模型已删、前端/路由已移除）。任务引擎仍保留
// knowledgeBaseService 注入位以兼容 runners 的 `?.` 守卫，这里显式传 null：
// 旧项目若残留 referenceKnowledgeDocumentIds，runner 会安全跳过而不是调用已不存在的模型。
// （原 createKnowledgeBaseStore 访问的 prisma.knowledge* 全为 undefined，是真实崩溃点。）
import { TaskService } from './tasks/service';
import { registerTaskRunners } from './tasks/runners';
import { createOpenCodeRuntimeService } from './agent/runtimeService';
import { createPiRuntimeService } from './agent/piRuntimeService';
import type { AgentService } from './agent/types';
import { eventBus } from './events/bus';
import { primeAppConfigCache, getLiveAgentAiConfig } from './config/store';
import { createAiDiagnosticStorage } from './ai-diagnostics/storage';
import { createAiDiagnosticsService } from './ai-diagnostics/service';
import { aiDiagnosticRoutes } from './ai-diagnostics/routes';
import { getAiDiagnosticsRoot } from './document/paths';
import { statsRoutes } from './routes/stats';
import { inviteRoutes } from './routes/invite';
import { quotaPublicRoutes, quotaRoutes } from './routes/quota';
import { startMermaidCacheCleanupTimer } from './export/mermaid';
import { analyticsAdminRoutes, analyticsVisitRoutes } from './routes/analytics';
import { healthRoutes } from './routes/health';
import { paymentPublicRoutes } from './routes/payment';
import { startQuotaOrderReconciler } from './payment/reconcile';
import { cleanupOldErrorLogs, recordErrorLog } from './errorlog/service';
import { setUsageStatsPrisma } from './ai/usageStats';

// 运行环境归一化 + 生产 fail-fast：NODE_ENV 大小写/缺失会 silently 退回开发语义
// （mock 短信、验证码旁路、任意 CORS），部署时必须在启动阶段暴露出来而不是带病运行。
const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
process.env.NODE_ENV = nodeEnv;
if (nodeEnv === 'production') {
  const problems: string[] = [];
  const warnings: string[] = [];
  const corsOrigins = (process.env.CORS_ORIGINS || '').trim();
  if (!corsOrigins || corsOrigins === '*') problems.push('CORS_ORIGINS 必须配置为前端域名白名单（不能为 *）');
  if (!(process.env.CONFIG_ENCRYPTION_KEY || '').trim()) problems.push('CONFIG_ENCRYPTION_KEY 必须配置，否则 AI 密钥将明文落库');
  const smsProvider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (smsProvider === 'mock') {
    problems.push('SMS_PROVIDER=mock 仅限本地/CI，生产必须 aliyun');
  } else if (smsProvider === 'aliyun') {
    for (const key of ['ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_CODE']) {
      if (!(process.env[key] || '').trim()) problems.push(`SMS_PROVIDER=aliyun 时必须配置 ${key}`);
    }
  } else if (smsProvider !== '') {
    problems.push(`SMS_PROVIDER 取值非法：${smsProvider}（仅支持 aliyun；短信未开通时留空）`);
  } else {
    // 预发布阶段允许短信未开通：普通用户无法登录，但管理员密码登录可用；配置 aliyun 后重启即可。
    warnings.push('SMS_PROVIDER 未配置：普通用户短信登录暂不可用（管理员密码登录不受影响）');
  }
  if ((process.env.E2E_CAPTCHA_BYPASS || '').trim() === '1') problems.push('E2E_CAPTCHA_BYPASS 不允许在生产开启');
  if (problems.length) {
    console.error('[startup] 生产环境配置不安全，拒绝启动：\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  for (const warning of warnings) console.warn('[startup] ' + warning);
}

const prisma = new PrismaClient({
  // 默认交互事务超时 5s → 30s：正文落库会逐行写大纲/章节，大目录 + 高并发下顶破 5s
  // 会抛 "Transaction already closed"。根治（saveOutlineData 批量化）后正常路径远低于此，此值仅作安全垫。
  transactionOptions: { timeout: 30_000 },
});

// API-12 埋点：ai/service.ts 与 agent runtime 深栈拿不到 app 实例，注入进程级 prisma 引用。
setUsageStatsPrisma(prisma);

// 任务引擎单例：跨请求共享 activeTasks 内存 + aiService 队列。
// runner 注册表此时为空（L3）；L4 调 taskService.registerRunner 落入 9 个真实 runner。
// 崩溃恢复按用户懒触发（getActiveTasks 时跑），不在 boot 全量扫描——与桌面 getActiveTasks 语义一致。
// technicalPlanStore 返回具体 TechnicalPlanState，engine 内部按 loose Record 处理，故此处收窄类型。
const technicalPlanStore = createTechnicalPlanStore(prisma);
const aiDiagnostics = createAiDiagnosticsService({
  prisma,
  storage: createAiDiagnosticStorage(getAiDiagnosticsRoot()),
  logger: { error: (error) => console.error('[ai-diagnostics]', error) },
});
// Agent 运行时（进程级单例）。YIBIAO_AGENT_RUNTIME 选 'pi'（默认：进程内 ESM SDK，零原生依赖）
// 或 'opencode'（M1-P7 sidecar 二进制回退，需 YIBIAO_OPENCODE_BIN）。两者共享同一 AI Proxy
// （复用平台 key）与 AgentService 契约，runner 无感切换。boot 失败（SDK 缺失 / 平台 AI key 未设）
// 被吞 → phase stopped/unhealthy；runner 既有 agent 守卫（if (!agentService?.runTask) / busy 哨兵 / 抛错）
// 据此降级——outline 走 LLM 兜底、content 软降级——不崩主服务。配置每请求经 getLiveAgentAiConfig live 读。
const agentRuntime = (process.env.YIBIAO_AGENT_RUNTIME || 'pi').toLowerCase();
const agentService: AgentService =
  agentRuntime === 'opencode'
    ? createOpenCodeRuntimeService({ binPath: process.env.YIBIAO_OPENCODE_BIN, loadConfig: getLiveAgentAiConfig })
    : createPiRuntimeService({ loadConfig: getLiveAgentAiConfig });
// pi ask-user：提问挂起/清除时，按 question.project_id 路由到对应项目的 SSE agent-question 通道。
// opencode 回退不实现 onQuestion（undefined），守卫跳过；project_id 缺省（V1 一次性任务）时前端退化为轮询。
agentService.onQuestion?.((question) => {
  if (question?.project_id != null) {
    eventBus.emit(String(question.project_id), 'agent-question', question);
  }
});
const taskService = new TaskService({
  prisma,
  aiService: getAiService(),
  agentService,
  technicalPlanStore: technicalPlanStore as unknown as {
    loadTechnicalPlan(projectId: number): Promise<Record<string, unknown>>;
    updateTechnicalPlan(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
    readTenderMarkdown(projectId: number): Promise<string>;
    readOriginalTenderMarkdown(projectId: number): Promise<string>;
    readOriginalPlanMarkdown(projectId: number): Promise<string>;
    prepareBidSectionExtraction(projectId: number): Promise<Record<string, unknown>>;
  },
  rejectionCheckStore: createRejectionCheckStore(prisma),
  duplicateCheckStore: createDuplicateCheckStore(prisma),
  knowledgeBaseService: null,
  aiDiagnostics,
});

// L4：注册已移植的 task runner（首个：rejection-items-extraction）。
// 未注册的 type 走 start-* 的 501 "执行器尚未注册" 兜底。
registerTaskRunners(taskService);

const app = Fastify({ logger: true });

// 安全响应头（轻量集）：nosniff 防 MIME 嗅探、DENY 防点击劫持、Referrer-Policy 限制来源外泄；
// HSTS 仅在 HTTPS 请求上发送（HTTP 开发环境浏览器会忽略，不产生误导）。
// 注意：SSE 路由 reply.hijack 后自写响应头，这几个头对 SSE 不生效——无碍。
// 完整 CSP 涉及内联样式/脚本与 mermaid/blob 图片策略，需单独批次验证后再启用。
app.addHook('onRequest', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // CSP：前端静态页由 nginx 直出（见 deploy/nginx 示例），这里覆盖 API 响应；
  // 两端保持一致，避免漏配。不放行 inline script；mermaid 需要 blob: worker 与内联样式。
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
});

// 暴露 prisma + taskService + agentService 给路由：app.prisma / app.taskService / app.agentService
app.decorate('prisma', prisma);
app.decorate('taskService', taskService);
app.decorate('agentService', agentService);
app.decorate('aiDiagnostics', aiDiagnostics);
void aiDiagnostics.cleanupExpired();

// CORS（H3 加固）：设置 CORS_ORIGINS 白名单后仅放行列表内来源；未设置时保持旧行为
// （反射任意 Origin），但打告警——公网部署务必配置，见 .env.example。
const allowedOrigins = getAllowedOrigins();
const isProduction = process.env.NODE_ENV === 'production';
if (allowedOrigins === null) {
  // 生产环境禁止回落到「反射任意 Origin」：漏配即等于放开跨域读取，必须启动即失败，
  // 让部署阶段就暴露问题，而不是带着开放 CORS 上线。
  if (isProduction) {
    throw new Error('生产环境必须设置 CORS_ORIGINS（逗号分隔的允许来源，如 https://your-domain.com）');
  }
  app.log.warn('CORS_ORIGINS 未设置：当前放行任意 Origin（仅建议本地开发使用）。生产部署请配置白名单，如 CORS_ORIGINS=https://your-domain.com');
}
await app.register(cors, {
  origin: allowedOrigins === null ? true : allowedOrigins,
  // 认证走 Authorization: Bearer（localStorage），不使用 cookie，故无需 credentials。
  credentials: false,
  // 必须显式声明：默认 preflight 只回 GET/HEAD/POST，会导致浏览器侧所有 PUT/DELETE/PATCH
  // 在预检后被静默拦截（net::ERR_FAILED，请求根本不到服务端）。配置保存、模板改删等均受影响。
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  // 跨域时浏览器 JS 只能读到默认安全名单里的响应头；导出文件名靠 Content-Disposition
  // 传递（dev 前端 5173 跨域直连 3000），不暴露则客户端永远拿不到文件名，下载名只会是 export.docx。
  exposedHeaders: ['Content-Disposition'],
});

// multipart：文件上传（P4）。单文件上限 50MB：招标文件/标书通常远小于此，
// 上限过大时 toBuffer/解析的并发内存峰值会直接打爆单实例（解析已改流式落盘）。
await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 20, parts: 40, fieldSize: 2 * 1024 * 1024 },
});

// 公开路由
await app.register(authRoutes, { prefix: '/api' });
// 站点访问埋点（公开：登录页匿名也可打点，登录态带 userId）
await app.register(analyticsVisitRoutes, { prefix: '/api' });
await app.register(systemSettingsPublicRoutes, { prefix: '/api' });
await app.register(healthRoutes, { prefix: '/api' });
await app.register(paymentPublicRoutes, { prefix: '/api' });
// 公开计价：登录页/邀请页展示套餐与注册赠送额度（不含任何用户数据）
await app.register(quotaPublicRoutes, { prefix: '/api' });

// 受保护路由（统一 onRequest 鉴权：JWT 验签 + 回查库吊销校验）
await app.register(
  async (protectedApp) => {
    protectedApp.addHook('onRequest', createVerifyToken(prisma));

    // /me：当前用户最新信息（权限即时生效的拉取端点，前端窗口聚焦/60s 定时调）。
    await protectedApp.register(meRoutes, { prefix: '/api' });

    // 非项目作用域：配置/系统设置/AI/文档/项目 CRUD/事件 SSE。
    await protectedApp.register(configRoutes, { prefix: '/api' });
    await protectedApp.register(systemSettingsAdminRoutes, { prefix: '/api' });
    await protectedApp.register(aiRoutes, { prefix: '/api' });
    await protectedApp.register(statsRoutes, { prefix: '/api' });
  await protectedApp.register(inviteRoutes, { prefix: '/api' });
    await protectedApp.register(quotaRoutes, { prefix: '/api' });
    await protectedApp.register(analyticsAdminRoutes, { prefix: '/api' });
    await protectedApp.register(documentRoutes, { prefix: '/api' });
    await protectedApp.register(projectRoutes, { prefix: '/api' });
    await protectedApp.register(eventRoutes, { prefix: '/api' });
    // 提示词目录只读：任何登录用户可读（招标解析页需拉任务列表）。promptText 正文见 admin 路由。
    await protectedApp.register(promptReadRoutes, { prefix: '/api' });
    // Agent sidecar 运维：status 登录可读，self-check/restart 路由内 admin 校验。
    await protectedApp.register(agentRoutes, { prefix: '/api' });
    // 模块门禁：使用文档。普通用户需 modules 含 docs。
    await protectedApp.register(async (docsApp) => {
      docsApp.addHook('onRequest', createRequireModule(prisma, 'docs'));
      await docsApp.register(docsRoutes, { prefix: '/api' });
    });

    // 模块门禁：问题FAQ（反馈问答）。普通用户需 modules 含 faq。
    await protectedApp.register(async (faqApp) => {
      faqApp.addHook('onRequest', createRequireModule(prisma, 'faq'));
      await faqApp.register(feedbackRoutes, { prefix: '/api' });
    });

    // 模块门禁：格式管理（ExportTemplate CRUD）。普通用户需 modules 含 template-settings。
    await protectedApp.register(async (formatApp) => {
      formatApp.addHook('onRequest', createRequireModule(prisma, 'template-settings'));
      await formatApp.register(templateRoutes, { prefix: '/api' });
    });

    // 知识库 / 资产资质库 / 人员资质库已随 DB-01~04 裁剪下线：对应 Prisma 模型已从 schema 删除，
    // 路由若继续注册只会在调用时抛 "Cannot read properties of undefined"，故整组不再挂载。

    // 管理员专属：用户管理（编辑/删除）+ 提示词管理（编辑招标/废标 prompt）。
    // verifyToken 之后叠加 requireAdmin。
    const requireAdmin = createRequireAdmin();
    await protectedApp.register(async (adminApp) => {
      adminApp.addHook('onRequest', requireAdmin);
      await adminApp.register(userRoutes, { prefix: '/api' });
      await adminApp.register(promptAdminRoutes, { prefix: '/api' });
      await adminApp.register(aiDiagnosticRoutes, { prefix: '/api' });
    });

    // 项目作用域：technical-plan/export/tasks（标书生成基础设施，默认开放）。
    // 标书检查（duplicate-check/rejection-check）叠加模块门禁 bid-check。
    const requireProject = createRequireProject(prisma);
    const requireBidCheck = createRequireModule(prisma, 'bid-check');
    await protectedApp.register(async (projectApp) => {
      projectApp.addHook('onRequest', requireProject);
      await projectApp.register(technicalPlanRoutes, { prefix: '/api' });
      await projectApp.register(exportRoutes, { prefix: '/api' });
      await projectApp.register(taskRoutes, { prefix: '/api' });
      await projectApp.register(async (bidCheckApp) => {
        bidCheckApp.addHook('onRequest', requireBidCheck);
        await bidCheckApp.register(duplicateCheckRoutes, { prefix: '/api' });
        await bidCheckApp.register(rejectionCheckRoutes, { prefix: '/api' });
      });
    });
  },
);

// 全局错误处理器（管理员报错管理）：5xx 自动落错误记录（脱敏摘要），其余保持 Fastify 默认行为
app.setErrorHandler((error, req, reply) => {
  const status = Number((error as any).statusCode) || 500;
  if (status >= 500) {
    app.log.error({ err: error, reqId: req.id }, 'unhandled error');
    void recordErrorLog(prisma, {
      userId: (req as any).user?.id ?? null,
      source: 'api',
      level: 'error',
      summary: `${req.method} ${req.url} → ${(error as Error).message}`,
      statusCode: status,
    });
    reply.code(500).send({ statusCode: 500, error: 'Internal Server Error', message: '服务器内部错误，请稍后重试' });
    return;
  }
  reply.code(status).send(error);
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`yibiao-server listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// API-36（局部）：mermaid 导出缓存每日清理（默认保留 7 天），boot 时先清一次
startMermaidCacheCleanupTimer();
setInterval(() => { void cleanupOldErrorLogs(prisma, 30); }, 24 * 60 * 60 * 1000);
// 支付宝通知是主链路；每 10 分钟兜底查询一次最近 pending 订单，处理回调丢失/用户提前关页。
startQuotaOrderReconciler(prisma, {
  info: (obj, msg) => app.log.info(obj, msg),
  warn: (obj, msg) => app.log.warn(obj, msg),
});

// 预暖平台配置缓存，使 agent sidecar boot 时 getLiveAgentAiConfig 立即可读；
// 随后非阻塞拉起 sidecar（失败仅 warn：runner 守卫据此降级，不崩主服务）。
void primeAppConfigCache(prisma)
  .then(() => agentService.boot())
  .catch((err) => app.log.warn({ err }, 'agent sidecar boot failed'));

// 优雅关闭：SIGTERM/SIGINT 先停 agent sidecar（abort 活动任务 + 关 opencode/proxy），再关 HTTP。
// server 原先无 signal handler，PM2 reload / docker stop 会直接 SIGTERM → 进程即时退出、
// agent sidecar 子进程残留。这里保证 sidecar 与主进程同生共死。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, shutting down`);
  try {
    await agentService.close();
  } catch (err) {
    app.log.warn({ err }, 'agent sidecar close failed');
  }
  try {
    await app.close();
  } catch (err) {
    app.log.warn({ err }, 'app close failed');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
