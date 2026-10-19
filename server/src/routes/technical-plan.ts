// 技术方案状态命名空间路由（受保护，按 projectId 隔离）。
// RPC 风格 POST：每条写路由返回完整 TechnicalPlanState（select-bid-section/clear 多一层 envelope）。
// 移植自 client/electron/ipc/technicalPlanIpc.cjs 的 1:1 透传契约。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getProjectId } from '../auth/middleware';
import { createRateLimit } from '../auth/rateLimit';
import { createTechnicalPlanStore } from '../technical-plan/store';
import type { TaskService } from '../tasks/service';
import { collectParsedImports } from '../document/multipart';
import { buildMerged } from '../config/store';

export async function technicalPlanRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createTechnicalPlanStore(prisma);
  const taskService = (app as unknown as { taskService?: TaskService }).taskService;

  // API-11：文件导入（multipart + 解析）按用户限流（20 次/分钟）。
  const importRateLimit = createRateLimit({ name: 'tp-import', windowMs: 60_000, max: 20 });

  const bodyOf = (req: FastifyRequest) => (req as FastifyRequest & { body: unknown }).body as Record<string, unknown> | undefined;

  app.get('/technical-plan/state', async (req) => store.loadTechnicalPlan(getProjectId(req)));

  app.post('/technical-plan/step', async (req) => store.updateStep(getProjectId(req), bodyOf(req)?.step));

  app.post('/technical-plan/workflow-kind', async (req) => store.setWorkflowKind(getProjectId(req), bodyOf(req)?.workflowKind));

  app.post('/technical-plan/switch-workflow-kind', async (req) => store.switchWorkflowKind(getProjectId(req), bodyOf(req)?.workflowKind));

  app.post('/technical-plan/bid-analysis-config', async (req) =>
    store.saveBidAnalysisConfig(
      getProjectId(req),
      bodyOf(req) as { mode?: unknown; selectedTaskIds?: unknown; bidSectionMode?: unknown },
    ),
  );

  app.post('/technical-plan/outline-config', async (req) =>
    store.saveOutlineConfig(
      getProjectId(req),
      bodyOf(req) as { referenceKnowledgeDocumentIds?: unknown; outlineMode?: unknown; outlineExpansionMode?: unknown; mirrorProcurementEnabled?: unknown; outlineWordControlOptions?: unknown },
    ),
  );

  app.post('/technical-plan/outline', async (req) =>
    store.saveOutline(
      getProjectId(req),
      bodyOf(req) as { outlineData?: unknown; reason?: string; idMap?: Record<string, string>; affectedNodeIds?: string[] },
    ),
  );

  app.post('/technical-plan/global-facts', async (req) => store.saveGlobalFacts(getProjectId(req), bodyOf(req)?.globalFacts));

  app.post('/technical-plan/content-generation-options', async (req) =>
    store.saveContentGenerationOptions(getProjectId(req), bodyOf(req)?.options),
  );

  app.post('/technical-plan/chapter-content', async (req) =>
    store.saveChapterContent(getProjectId(req), bodyOf(req) as { nodeId?: string; content?: unknown }),
  );

  app.post('/technical-plan/select-bid-section', async (req) =>
    store.selectBidSection(getProjectId(req), bodyOf(req)?.selectedSection as { id?: string; title?: string }),
  );

  // 清空前先终止运行中任务：否则任务组锁残留，重开流程的首个 start-* 会 409（任务组互斥）。
  app.post('/technical-plan/clear', async (req) => {
    const projectId = getProjectId(req);
    await taskService?.cancelProjectTasks(projectId);
    return store.clear(projectId);
  });

  // 文件导入（multipart）：bridge 侧 pickFiles → FormData 上传，route 解析后交 store 落盘+写库。
  app.post('/technical-plan/import-tender-document', { onRequest: importRateLimit }, async (req, reply) => {
    const { docs, errors, officeMissing } = await collectParsedImports(req);
    if (!docs.length) {
      return reply.code(officeMissing ? 415 : 422).send({
        error: errors.join('; ') || '未导入文件',
        code: officeMissing ? 'office_backend_missing' : 'parse_failed',
        officeBackendMissing: officeMissing,
      });
    }
    return store.importTenderDocument(getProjectId(req), docs);
  });

  app.post('/technical-plan/import-original-plan-document', { onRequest: importRateLimit }, async (req, reply) => {
    const { docs, errors, officeMissing } = await collectParsedImports(req);
    if (!docs.length) {
      return reply.code(officeMissing ? 415 : 422).send({
        error: errors.join('; ') || '未导入文件',
        code: officeMissing ? 'office_backend_missing' : 'parse_failed',
        officeBackendMissing: officeMissing,
      });
    }
    return store.importOriginalPlanDocument(getProjectId(req), docs);
  });

  // FS 读（P4-2：从工作区磁盘读回招标/原方案 markdown，可能为空串）
  app.get('/technical-plan/tender-markdown', async (req) => store.readTenderMarkdown(getProjectId(req)));
  app.get('/technical-plan/tender-source-markdown/:sourceId', async (req) =>
    store.readTenderSourceMarkdown(getProjectId(req), (req.params as { sourceId: string }).sourceId),
  );
  app.get('/technical-plan/original-plan-markdown', async (req) => store.readOriginalPlanMarkdown(getProjectId(req)));
  app.get('/technical-plan/bid-sections', async (req) => store.checkBidSections(getProjectId(req)));

  // ---- 语义化局部改写 + AI 图表生成（编辑器辅助工具） ----
  // 两者均项目作用域 + 用户限流；AI 调用走平台统一配置（多 Key 轮询/公平队列自动生效），
  // 计费原则与生成一致：改写/配图不即时扣费，最终随导出字数统一计费。
  const aiToolsRateLimit = createRateLimit({ name: 'tp-ai-tools', windowMs: 60_000, max: 30 });
  const ai = (await import('../ai/service')).getAiService();

  const REWRITE_ACTIONS: Record<string, string> = {
    rewrite: '改写选中文本：保持原意与信息量，换一种更专业、更符合标书文风的表达，避免与原文重复用词。',
    expand: '扩写选中文本：在不编造事实的前提下补充细节、手段与保障措施，使论述更充实（字数约为原文的 1.5~2 倍）。',
    shorten: '精简选中文本：删除冗余表述，保留核心信息与关键承诺，字数压缩为原文的 60% 左右。',
    formal: '将选中文本改写为更正式的标书书面语：以我方（投标方）为主体使用承诺口吻（将/承诺/确保），删除口语化表达。',
  };

  app.post('/technical-plan/rewrite-selection', { onRequest: aiToolsRateLimit }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number } }).user;
    const body = (bodyOf(req) ?? {}) as { text?: unknown; action?: unknown; chapterTitle?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const action = typeof body.action === 'string' ? body.action : '';
    if (!text) return reply.code(400).send({ error: '请先选中要处理的文字' });
    if (text.length > 20000) return reply.code(400).send({ error: '选中文本过长（上限 2 万字）' });
    const instruction = REWRITE_ACTIONS[action];
    if (!instruction) return reply.code(400).send({ error: '未知的处理方式' });
    const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0, 100) : '';

    const config = await buildMerged(prisma, user.id);
    config.__statUserId = user.id;
    config.__statBizType = 'rewrite';
    const content = await ai.chat(config, {
      messages: [
        {
          role: 'system',
          content: `你是投标技术方案的正文编辑专家，负责对选中文字做定向润色处理。${chapterTitle ? `当前小节：${chapterTitle}。` : ''}
要求：
1. 只输出处理后的正文文字，不要任何解释、前缀或标题。
2. 遵守标书写作规范：正式书面语；我方（投标方）职责用承诺口吻（将/承诺/确保），不使用"须/应/必须"等规定性措辞描述我方义务。
3. 缺证兜底：原文未提供的具体人员、时间、地点、业绩、证书、规格型号，保持笼统口径（如"按招标要求配备相应人员"），不得编造。`,
        },
        { role: 'user', content: `${instruction}\n\n选中文本：\n${text}` },
      ],
      temperature: 0.6,
    });
    return { content: String(content || '').trim() };
  });

  const DIAGRAM_TYPES: Record<string, string> = {
    flowchart: 'mermaid flowchart（流程图），使用 graph TD 或 graph LR',
    sequence: 'mermaid sequenceDiagram（时序图）',
    gantt: 'mermaid gantt（甘特图/进度计划），dateFormat 保持 YYYY-MM-DD',
    org: '嵌套无序列表形式的组织架构（配合缩进层级表达汇报关系），输出为 HTML 片段',
    structure: 'HTML 表格形式的系统架构/组成表（table>tr>td，可用 rowspan/colspan 表达层级）',
  };

  app.post('/technical-plan/generate-diagram', { onRequest: aiToolsRateLimit }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number } }).user;
    const body = (bodyOf(req) ?? {}) as { type?: unknown; topic?: unknown; context?: unknown };
    const type = typeof body.type === 'string' ? body.type : '';
    const diagramRule = DIAGRAM_TYPES[type];
    if (!diagramRule) return reply.code(400).send({ error: '未知的图表类型' });
    const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 200) : '';
    const context = typeof body.context === 'string' ? body.context.trim().slice(0, 6000) : '';
    if (!topic && !context) return reply.code(400).send({ error: '请填写图表主题或提供小节内容' });

    const config = await buildMerged(prisma, user.id);
    config.__statUserId = user.id;
    config.__statBizType = 'generate';
    const content = await ai.chat(config, {
      messages: [
        {
          role: 'system',
          content: `你是投标技术方案的图表绘制助手。请根据主题与小节内容生成图表定义，要求：
1. 输出格式：${diagramRule}。
2. 内容必须来自给定的小节内容/主题，不编造具体人名、日期与数字（进度类可用"第 N 周/M+N 天"相对表述）。
3. 节点/条目数量 4~10 个，命名专业简洁，符合标书文风。
4. 只输出图表定义本身（mermaid 代码或 HTML 片段），不要 markdown 代码围栏，不要任何解释。`,
        },
        { role: 'user', content: `图表主题：${topic || '按小节内容提炼'}\n\n小节内容（可节选）：\n${context || '（无，请按主题合理展开）'}` },
      ],
      temperature: 0.4,
    });
    return { content: String(content || '').trim() };
  });

}
