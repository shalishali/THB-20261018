// 导出 Word 路由（受保护、项目作用域——requireProject preHandler 挂 req.projectId）。
// POST /api/export/word → 服务端渲染 docx 并以 attachment 流回浏览器。
// 进度经 EventBus 的 export-progress 通道推 SSE（按 projectId 路由，requestId 过滤）。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { trackActivity } from '../analytics/service';
import { recordErrorLog } from '../errorlog/service';
import { getProjectId, getUser } from '../auth/middleware';
import { exportWordToBuffer } from '../export/service';
import { convertDocxBufferToPdf } from '../export/pdf';
import type { ExportWordPayload } from '../export/format';
import { eventBus } from '../events/bus';
import { normalizeSubjectReplacements } from '../tasks/utils/subjectReplacement';
import { createWorkspacePaths } from '../document/paths';
import { QuotaInsufficientError, chargeExportQuota } from './quota';
import { QUOTA_PLANS, countOutlineContentChars, recordQuotaConsumeLog } from '../quota/service';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// RFC 5987 编码中文文件名：filename="fallback"; filename*=UTF-8''%E6%A0%87...
function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'export.docx';
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function exportRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: import('@prisma/client').PrismaClient }).prisma;
  app.post('/export/word', { bodyLimit: 50 * 1024 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
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

    // 字数额度：导出构建成功后按正文字数（非空白字符，口径与正文统计一致）扣减当前用户额度。
    // 同一内容重复导出不重复扣费：比对项目级内容指纹（字数+内容哈希），一致则直接放行；
    // 内容有变化（重新生成/编辑过正文）才会再次计费。余额不足 → 402 + 结构化信息。
    const exportChars = countOutlineContentChars(payload.outline);
    const exportFingerprint = createHash('sha256')
      .update(`${exportChars}:${JSON.stringify(payload.outline?.map((node: any) => node?.content || ''))}`)
      .digest('hex');
    let existing: { quotaFingerprint: string | null } | null = null;
    try {
      existing = await prisma.project.findUnique({
        where: { id: Number(projectId) },
        select: { quotaFingerprint: true },
      });
    } catch (err) {
      req.log.warn({ err, projectId }, '读取导出计费指纹失败（按未计费处理）');
    }
    if (existing?.quotaFingerprint && existing.quotaFingerprint === exportFingerprint) {
      req.log.info({ projectId, userId: getUser(req).id, chars: exportChars }, 'export skipped charging: identical content already billed');
    } else {
      try {
        await chargeExportQuota(prisma, getUser(req).id, exportChars);
        await prisma.project.update({
          where: { id: Number(projectId) },
          data: { quotaFingerprint: exportFingerprint },
        });
        // DB-17：扣费成功落消费流水（同内容重复导出已在上面的指纹判断中跳过）
        await recordQuotaConsumeLog(prisma, getUser(req).id, exportChars, {
          projectId: Number(projectId),
          fingerprint: exportFingerprint,
        });
      } catch (error) {
        if (error instanceof QuotaInsufficientError) {
          req.log.warn({ projectId, userId: getUser(req).id, required: error.required, balance: error.balance }, 'export blocked: quota insufficient');
        void recordErrorLog(prisma, { userId: getUser(req).id, projectId: Number(projectId), level: 'warn', source: 'export', summary: '字数额度不足，导出被拦截（需 ' + error.required + ' 字，余额 ' + error.balance + ' 字）', statusCode: 402 });
          return reply.code(402).send({
            error: error.message,
            code: 'QUOTA_INSUFFICIENT',
            required: error.required,
            balance: error.balance,
            plans: QUOTA_PLANS,
          });
        }
        throw error;
      }
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

  // POST /export/pdf → 复用 Word 构建 + LibreOffice 转 PDF（API-33）。
  // 计费口径与 Word 一致：同内容指纹已计费则不再扣（Word/PDF 共享项目级指纹）。
  app.post('/export/pdf', { bodyLimit: 50 * 1024 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req as FastifyRequest & { body: unknown }).body as ExportWordPayload | undefined;
    const projectId = String(getProjectId(req));
    const requestId = body?.requestId;

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
      base_dir: createWorkspacePaths(Number(projectId)).workspaceDir,
      subject_replacement_comment_terms: subjectReplacementCommentTerms,
    };

    let result;
    try {
      result = await exportWordToBuffer(payload, { onProgress: () => {} });
    } catch (error) {
      const message = (error as Error).message || '导出失败';
      req.log.error({ err: error, projectId }, 'export/pdf build failed');
      return reply.code(400).send({ error: message });
    }

    const exportChars = countOutlineContentChars(payload.outline);
    const exportFingerprint = createHash('sha256')
      .update(`${exportChars}:${JSON.stringify(payload.outline?.map((node: any) => node?.content || ''))}`)
      .digest('hex');
    let existing: { quotaFingerprint: string | null } | null = null;
    try {
      existing = await prisma.project.findUnique({ where: { id: Number(projectId) }, select: { quotaFingerprint: true } });
    } catch { /* 按未计费处理 */ }
    if (!(existing?.quotaFingerprint && existing.quotaFingerprint === exportFingerprint)) {
      try {
        await chargeExportQuota(prisma, getUser(req).id, exportChars);
        await prisma.project.update({ where: { id: Number(projectId) }, data: { quotaFingerprint: exportFingerprint } });
        await recordQuotaConsumeLog(prisma, getUser(req).id, exportChars, { projectId: Number(projectId), fingerprint: exportFingerprint });
      } catch (error) {
        if (error instanceof QuotaInsufficientError) {
          return reply.code(402).send({
            error: error.message,
            code: 'QUOTA_INSUFFICIENT',
            required: error.required,
            balance: error.balance,
            plans: QUOTA_PLANS,
          });
        }
        throw error;
      }
    }

    try {
      const pdfBuffer = await convertDocxBufferToPdf(result.buffer);
      const pdfName = result.filename.replace(/\.docx$/i, '') + '.pdf';
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', buildContentDisposition(pdfName))
        .header('Content-Length', String(pdfBuffer.length))
        .send(pdfBuffer);
    } catch (error) {
      const message = (error as Error).message || 'PDF 转换失败';
      req.log.error({ err: error, projectId }, 'export/pdf convert failed');
      void recordErrorLog(prisma, { userId: getUser(req).id, projectId: Number(projectId), level: 'error', source: 'export', summary: 'PDF 转换失败：' + ((error as Error).message || ''), statusCode: null });
      return reply.code(500).send({ error: message });
    }
  });
}
