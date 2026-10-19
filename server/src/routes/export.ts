// 导出 Word 路由（受保护、项目作用域——requireProject preHandler 挂 req.projectId）。
// POST /api/export/word → 服务端渲染 docx 并以 attachment 流回浏览器。
// 进度经 EventBus 的 export-progress 通道推 SSE（按 projectId 路由，requestId 过滤）。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { trackActivity } from '../analytics/service';
import { recordErrorLog } from '../errorlog/service';
import { getProjectId, getUser } from '../auth/middleware';
import { exportWordToBuffer } from '../export/service';
import type { ExportWordPayload } from '../export/format';
import { eventBus } from '../events/bus';
import { normalizeSubjectReplacements } from '../tasks/utils/subjectReplacement';
import { createWorkspacePaths } from '../document/paths';
import { QuotaInsufficientError, chargeExportOnce } from './quota';
import { buildExportContentFingerprint, buildLegacyExportFingerprints, countOutlineContentChars, getQuotaPricing, isExportAlreadyBilled } from '../quota/service';
import { createRateLimit } from '../auth/rateLimit';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// RFC 5987 编码中文文件名：filename="fallback"; filename*=UTF-8''%E6%A0%87...
function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'export.docx';
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function exportRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: import('@prisma/client').PrismaClient }).prisma;
  // 导出是全站最重的同步 CPU/内存操作（解析大纲 + markdown 渲染 + mermaid 转图 + docx 组装），
  // 而任务引擎/限流桶都是单实例内存态：不挂限流时几条并发导出即可拖垮全站。
  const exportRateLimit = createRateLimit({ name: 'export', windowMs: 60_000, max: 5 });
  app.post('/export/word', { bodyLimit: 20 * 1024 * 1024, onRequest: exportRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req as FastifyRequest & { body: unknown }).body as ExportWordPayload | undefined;
    const projectId = String(getProjectId(req));
    const requestId = body?.requestId;

    // 编号(projectCode)仅服务端从 DB 取（客户端不传）；名称优先用客户端值，兜底 DB。
    let projectCode: string | undefined;
    let projectName: string | undefined = body?.project_name;
    let subjectReplacementCommentTerms: string[] = [];
    try {
      const project = await prisma.project.findUnique({
        where: { id: Number(projectId) },
        select: { projectCode: true, name: true, subjectReplacements: true },
      });
      if (project?.projectCode) projectCode = project.projectCode;
      if (!projectName && project?.name) projectName = project.name;
      subjectReplacementCommentTerms = [...new Set(
        normalizeSubjectReplacements(project?.subjectReplacements)
          .map((item) => String(item.fullname || '').trim())
          .filter(Boolean),
      )];
    } catch (err) {
      req.log.warn({ err, projectId }, '读取项目编号/名称失败（不影响导出）');
    }

    const payload: ExportWordPayload = {
      requestId,
      project_code: projectCode,
      project_name: projectName,
      outline: Array.isArray(body?.outline) ? body.outline : [],
      export_format: body?.export_format ?? null,
      // SSRF/任意文件读加固：图片加载的本地基准目录由服务端固定为该项目工作区，
      // 不再信任客户端传入的 base_dir/baseDir（客户端内容里的本地图片引用本就应
      // 是工作区相对路径；越出工作区的引用会被 images.ts 拒绝并降级为占位提示）。
      base_dir: createWorkspacePaths(Number(projectId)).workspaceDir,
      // 浏览器预渲染的 Mermaid 图（PNG data URL）：服务端优先使用，避免导出时逐张联网 mermaid.ink。
      mermaid_images: Array.isArray((body as { mermaid_images?: unknown })?.mermaid_images)
        ? ((body as { mermaid_images: Array<{ code: string; data_url: string }> }).mermaid_images)
        : undefined,
      subject_replacement_comment_terms: subjectReplacementCommentTerms,
    };

    // onProgress → SSE export-progress 通道（按 requestId 过滤，UI 只关心自己发起的那次）。
    const onProgress = (event: { phase?: string; progress?: number; message?: string; warnings?: string[] }) => {
      eventBus.emit(projectId, 'export-progress', {
        requestId,
        phase: event.phase || 'running',
        progress: typeof event.progress === 'number' ? event.progress : 0,
        message: event.message || '',
        warnings: event.warnings || [],
      });
    };

    // 计费口径与渲染口径必须同源：先按正文字数计数，并在渲染前做余额预检。
    // 余额不足时直接 402，不做任何渲染（否则零余额用户可反复让服务端完成最重的渲染流程）。
    // 真正的原子扣减仍在渲染成功后的 chargeExportOnce 里完成（避免渲染失败已扣费）。
    const exportChars = countOutlineContentChars(payload.outline);
    if (exportChars <= 0) {
      return reply.code(400).send({ error: '没有可导出的正文内容，请先生成技术方案正文' });
    }
    // 指纹只看内容；同时兼容历史「字数+内容」两种旧格式（详见 buildLegacyExportFingerprints）。
    const exportFingerprint = buildExportContentFingerprint(payload.outline);
    const legacyFingerprints = buildLegacyExportFingerprints(payload.outline, exportChars);
    const billedBefore = await isExportAlreadyBilled(prisma, getUser(req).id, [exportFingerprint, ...legacyFingerprints]);
    // 同内容已计费的重复导出：跳过余额预检（余额不足也不该拦，更不该再扣一次）。
    if (!billedBefore) {
      const account = await prisma.user.findUnique({
        where: { id: getUser(req).id },
        select: { quotaChars: true },
      });
      const balance = Number(account?.quotaChars || 0);
      if (balance < exportChars) {
        void recordErrorLog(prisma, { userId: getUser(req).id, projectId: Number(projectId), level: 'warn', source: 'export', summary: '字数额度不足，导出被拦截（需 ' + exportChars + ' 字，余额 ' + balance + ' 字）', statusCode: 402 });
        return reply.code(402).send({
          error: `字数额度不足：本次导出需 ${exportChars} 字，当前余额 ${balance} 字`,
          code: 'QUOTA_INSUFFICIENT',
          required: exportChars,
          balance,
          plans: (await getQuotaPricing(prisma)).plans,
        });
      }
    }

    let result;
    try {
      result = await exportWordToBuffer(payload, { onProgress });
    } catch (error) {
      const message = (error as Error).message || '导出失败';
      req.log.error({ err: error, projectId }, 'export/word failed');
      void recordErrorLog(prisma, { userId: getUser(req).id, projectId: Number(projectId), level: 'error', source: 'export', summary: 'Word 构建失败：' + ((error as Error).message || ''), statusCode: null });
      eventBus.emit(projectId, 'export-progress', { requestId, phase: 'error', progress: 100, message, warnings: [] });
      return reply.code(400).send({ error: message });
    }

    // 字数额度：导出构建成功后按正文字数扣减当前用户额度。
    // 同一内容重复导出不重复扣费：内容指纹 + 扣费 + 消费流水在 chargeExportOnce 的同一事务里
    // 完成；matchFingerprints 让升级前按旧口径存下的流水也能命中。
    try {
      const { alreadyBilled } = await chargeExportOnce(prisma, {
        userId: getUser(req).id,
        projectId: Number(projectId),
        chars: exportChars,
        fingerprint: exportFingerprint,
        matchFingerprints: legacyFingerprints,
      });
      if (alreadyBilled) {
        req.log.info({ projectId, userId: getUser(req).id, chars: exportChars }, 'export skipped charging: identical content already billed');
      }
    } catch (error) {
      if (error instanceof QuotaInsufficientError) {
        req.log.warn({ projectId, userId: getUser(req).id, required: error.required, balance: error.balance }, 'export blocked: quota insufficient');
        void recordErrorLog(prisma, { userId: getUser(req).id, projectId: Number(projectId), level: 'warn', source: 'export', summary: '字数额度不足，导出被拦截（需 ' + error.required + ' 字，余额 ' + error.balance + ' 字）', statusCode: 402 });
        return reply.code(402).send({
          error: error.message,
          code: 'QUOTA_INSUFFICIENT',
          required: error.required,
          balance: error.balance,
          plans: (await getQuotaPricing(prisma)).plans,
        });
      }
      throw error;
    }

    void trackActivity(prisma, getUser(req).id, 'export', { format: 'word', chars: exportChars });

    // 记录最近一次成功导出时间（best-effort，失败不阻断下载）。仪表盘进度据此判定：正文完成 + 导出过 → 100%。
    try {
      await prisma.project.update({ where: { id: Number(projectId) }, data: { lastExportedAt: new Date() } });
    } catch (err) {
      req.log.warn({ err, projectId }, '记录导出时间失败（不影响下载）');
    }

    return reply
      .header('Content-Type', DOCX_MIME)
      .header('Content-Disposition', buildContentDisposition(result.filename))
      .header('Content-Length', String(result.buffer.length))
      .send(result.buffer);
  });
}
