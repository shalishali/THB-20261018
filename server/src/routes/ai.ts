import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import { getProjectIdHeader } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { buildMerged } from '../config/store';
import { getAiService } from '../ai/service';
import { resolveApiKeyPool } from '../ai/keyPool';
import { createRateLimit } from '../auth/rateLimit';

// 受保护路由（需登录）：AI 代理。服务端持真实 key，浏览器永远拿不到明文 key。
// POST /api/ai/chat             → 文本对话（上游流式内部聚合，返回完整 content 字符串）
// POST /api/ai/request-json     → JSON 结构化请求（带重试 + 修复，返回解析后对象）
// POST /api/ai/list-models      → 拉取上游模型列表（body 为表单 config 覆盖，可选；仅管理员）
// POST /api/ai/test-image-model → 生图模型连通性测试（body 为表单 config，含真实 key；仅管理员）

// AI 代理输入字数闸：浏览器侧合法调用只有设置页连通性测试（'hi'）与开发者测试页样例，
// 服务端任务 runner（招标解析/目录/正文生成等大上下文链路）走 tasks/service 内部 aiService，
// 不经过本代理。不设闸时该接口可被脚本当免费 LLM 网关刷平台 token（CHANGELOG 已知遗留）。
const AI_PROXY_MAX_INPUT_CHARS = 50_000;
// 输出 token 钳制：客户端未传 max_tokens 时上游按模型默认放开，这里统一给代理请求封顶，
// 防"一次请求打满上游输出预算"的滥用。任务 runner 不受影响（不经过本路由）。
const AI_PROXY_MAX_OUTPUT_TOKENS = 8_192;

// 统计 messages 的输入字数：content 兼容 string 与多模态数组（{type:'text',text}）。
function countMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let sum = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (typeof content === 'string') {
      sum += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === 'string') sum += text.length;
      }
    }
  }
  return sum;
}

// 代理请求体消毒：校验 messages 形状、拦截超限输入、钳制 max_tokens。
// 返回错误文案（null 表示通过）；钳制直接改写传入对象（body 本就是路由私有的解析产物）。
function sanitizeProxyBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages)) {
    return '请求体缺少 messages 数组';
  }
  const typed = body as { messages: unknown; max_tokens?: unknown };
  const inputChars = countMessagesChars(typed.messages);
  if (inputChars > AI_PROXY_MAX_INPUT_CHARS) {
    return `输入内容超过上限（${inputChars} 字 > 上限 ${AI_PROXY_MAX_INPUT_CHARS} 字），请减小输入或改用项目任务链路`;
  }
  const requested = Number(typed.max_tokens);
  typed.max_tokens = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), AI_PROXY_MAX_OUTPUT_TOKENS)
    : AI_PROXY_MAX_OUTPUT_TOKENS;
  return null;
}

// 模型配置类代理接口仅管理员：表单连通性测试属管理员设置页功能（普通用户界面本就不可见模型配置，
// FE-08），且 body 可携带任意 base_url 交给服务端 fetch——不设门禁等于给全体注册用户开内网 SSRF 面。
function isAdminRequest(req: FastifyRequest): boolean {
  return (req as FastifyRequest & { user?: JwtPayload }).user?.role === 'admin';
}

export async function aiRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const ai = getAiService();

  // API-11：AI 代理接口按用户限流（30 次/分钟），防绕过前端白嫖平台 key 刷模型。
  const aiRateLimit = createRateLimit({ name: 'ai-proxy', windowMs: 60_000, max: 30 });

  // aiService 抛出的 Error 带 .status/.message + 可能的 aiHttpError（上游响应）。
  // 关键：绝不能把上游 401（API key 无效）透传成路由 401——客户端 http 拦截器会把 401
  // 当作"JWT 失效"自动登出。上游错误统一映射为 502（网关），本地配置/校验错误 400。
  function sendError(reply: any, error: any) {
    let code = 500;
    if (error?.aiHttpError || error?.ai_http_error) code = 502;
    else if (error?.status === 400 || error?.statusCode === 400) code = 400;
    reply.code(code);
    return { success: false, message: error?.message || 'AI 请求失败' };
  }

  // 在 config 上打戳当前项目 id（读 X-Project-Id 头并校验归属；/ai 非项目作用域，校验失败静默丢弃）。
  // 归属校验是必须的：emitAiHttpError 会按 __sseProjectId 向该项目的 SSE 通道 fan-out 上游错误文案，
  // 不校验时任何登录用户可借伪造 X-Project-Id 向他人项目投递自定义错误弹窗（钓鱼面）。
  // 顺带修埋点：__sseProjectId 此前存的是 string，recordTextTokenStats 按 number 判断恒为 null，
  // AI 代理两条路由的 AiCallStat.projectId 从未落过值。
  async function stampProjectId(config: any, req: FastifyRequest, bizType?: string): Promise<any> {
    const projectIdHeader = getProjectIdHeader(req);
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    if (config && typeof config === 'object') {
      if (projectIdHeader && typeof user?.id === 'number') {
        const projectId = Number(projectIdHeader);
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
        if (project && (project.ownerId === user.id || user.role === 'admin')) {
          config.__sseProjectId = projectId;
        }
      }
      if (typeof user?.id === 'number') config.__statUserId = user.id;
      config.__statBizType = bizType || 'generate';
    }
    return config;
  }

  app.post('/ai/chat', { onRequest: aiRateLimit }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    // 收紧：chat/request-json 只服务于设置页管理员连通性测试，任务生成链路走 tasks/service 内部
    // aiService，不经过本代理。此前对任意登录用户开放，可被脚本当免费 LLM 网关刷平台 token。
    if (!isAdminRequest(req)) {
      reply.code(403);
      return { success: false, message: '仅管理员可调用 AI 代理' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body;
    const invalidReason = sanitizeProxyBody(body);
    if (invalidReason) {
      reply.code(400);
      return { success: false, message: invalidReason };
    }
    try {
      const config = await stampProjectId(await buildMerged(prisma, user.id), req);
      const content = await ai.chat(config, body);
      return { content };
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  app.post('/ai/request-json', { onRequest: aiRateLimit }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (!isAdminRequest(req)) {
      reply.code(403);
      return { success: false, message: '仅管理员可调用 AI 代理' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body;
    const invalidReason = sanitizeProxyBody(body);
    if (invalidReason) {
      reply.code(400);
      return { success: false, message: invalidReason };
    }
    try {
      const config = await stampProjectId(await buildMerged(prisma, user.id), req);
      const result = await ai.requestJson(config, body);
      return { result };
    } catch (error: any) {
      return sendError(reply, error);
    }
  });


  app.post('/ai/list-models', { onRequest: aiRateLimit }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (!isAdminRequest(req)) {
      reply.code(403);
      return { success: false, message: '仅管理员可测试模型连通性' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body as any;
    try {
      // body 为表单 config 覆盖（含用户正要测试的真实 key/base_url）；缺省回落到存储配置。
      const config = await stampProjectId(
        (body && (body.api_key || body.base_url)) ? body : await buildMerged(prisma, user.id),
        req,
      );
      return await ai.listModels(config);
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  app.post('/ai/test-image-model', { onRequest: aiRateLimit }, async (req, reply) => {
    if (!isAdminRequest(req)) {
      reply.code(403);
      return { success: false, message: '仅管理员可测试生图模型连通性' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body as any;
    try {
      // 表单 config（含真实 key）由前端提供；服务端只做代理测试，不落盘。
      return await ai.testImageModel(await stampProjectId(body || {}, req));
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  // POST /ai/test-key-pool { base_url?, model_name?, api_keys?: string[] } → 逐条目连通性测试。
  // 条目格式与 Key 池一致（key / key|Base URL|模型名）；每条目用其自身端点+Key 请求上游 /models，
  // 返回连通结果、耗时、模型总数，并校验条目指定模型是否在上游列表中（模型名写错保存前就能发现）。
  app.post('/ai/test-key-pool', { onRequest: aiRateLimit }, async (req, reply) => {
    if (!isAdminRequest(req)) {
      reply.code(403);
      return { success: false, message: '仅管理员可测试 Key 池' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body as {
      base_url?: unknown;
      model_name?: unknown;
      api_keys?: unknown;
    };
    const config = {
      base_url: typeof body?.base_url === 'string' ? body.base_url : '',
      model_name: typeof body?.model_name === 'string' ? body.model_name : '',
      api_key: '',
      api_keys: Array.isArray(body?.api_keys) ? body.api_keys.filter((item): item is string => typeof item === 'string') : [],
    };
    const pool = resolveApiKeyPool(config);
    if (pool.length === 0) {
      reply.code(400);
      return { success: false, message: 'Key 池为空：请先填写主 Key 或 Key 池条目' };
    }
    const results: Array<Record<string, unknown>> = [];
    for (const entry of pool) {
      const started = Date.now();
      const masked = entry.key.length <= 10
        ? `${entry.key.slice(0, 2)}****`
        : `${entry.key.slice(0, 6)}****${entry.key.slice(-4)}`;
      try {
        const outcome = (await Promise.race([
          ai.listModels({ base_url: entry.base_url, api_key: entry.key, model_name: entry.model_name }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('测试超时（10 秒）')), 10_000)),
        ])) as { success?: boolean; message?: string; models?: string[] } | undefined;
        const models = Array.isArray(outcome?.models) ? outcome.models : [];
        results.push({
          key_masked: masked,
          base_url: entry.base_url,
          model_name: entry.model_name,
          ok: outcome?.success === true,
          latency_ms: Date.now() - started,
          models_count: models.length,
          model_found: models.length > 0 ? models.includes(entry.model_name) : null,
          message: String(outcome?.message || ''),
        });
      } catch (error: any) {
        results.push({
          key_masked: masked,
          base_url: entry.base_url,
          model_name: entry.model_name,
          ok: false,
          latency_ms: Date.now() - started,
          models_count: 0,
          model_found: null,
          message: error?.message || '测试失败',
        });
      }
    }
    return { success: true, results };
  });
}
