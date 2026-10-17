// 通用文档上传+解析路由（受保护，按 userId 隔离临时文件）。
// 这是 P4-1 的验证脚手架：multipart 上传单文件 → 落临时文件 → parseDocument → 返回 markdown。
// 域专属上传路由（technical-plan/import-tender、rejection-check/import-document、knowledge-base/upload、
// duplicate-check/select-files）在 P4-2/P4-3 接入，复用同一 parseDocument。
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtPayload } from '../auth/middleware';
import { parseDocument, isLibreOfficeMissingError, LOCAL_SUPPORTED_EXTENSIONS } from '../document/parser';
import { isAllowedUploadExtension, extensionWhitelistLabel } from '../document/multipart';
import { createRateLimit } from '../auth/rateLimit';
import { getUser } from '../auth/middleware';
import { recordErrorLog } from '../errorlog/service';

export async function documentRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const userIdOf = (req: FastifyRequest) => (req as FastifyRequest & { user: JwtPayload }).user.id;

  // API-11：文档解析（临时落盘 + LibreOffice/MinerU）按用户限流（20 次/分钟）。
  const parseRateLimit = createRateLimit({ name: 'doc-parse', windowMs: 60_000, max: 20 });

  // GET /documents/supported-extensions → 支持的扩展名清单（前端可据此限制 input accept）
  app.get('/documents/supported-extensions', async () => ({
    extensions: [...LOCAL_SUPPORTED_EXTENSIONS],
  }));

  // POST /documents/parse (multipart, field "file") → { fileName, markdown, chars, hash, parserLabel }
  // 供 P4-1 验证；不落工作区磁盘，不写 DB。临时文件用完即删。
  app.post('/documents/parse', { onRequest: parseRateLimit }, async (req, reply) => {
    const userId = userIdOf(req);
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: '缺少文件（field name 应为 file）' });
    }
    const fileName = String(file.filename || 'upload');
    const ext = path.extname(fileName).toLowerCase();
    // API-09：后缀白名单（单文件大小由全局 multipart fileSize=100MB 限制）。
    if (!isAllowedUploadExtension(ext)) {
      return reply.code(400).send({
        error: `不支持的文件类型 ${ext || '(无后缀)'}，支持：${extensionWhitelistLabel()}`,
        code: 'unsupported_extension',
        fileName,
      });
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `yibiao-parse-${userId}-`));
    const tmpPath = path.join(tmpDir, `upload${ext || ''}`);
    try {
      const buffer = await file.toBuffer();
      await fs.writeFile(tmpPath, buffer);
      const result = await parseDocument(tmpPath);
      return {
        fileName,
        extension: ext,
        markdown: result.markdown,
        chars: result.chars,
        hash: result.hash,
        parserLabel: result.parserLabel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isOfficeMissing = isLibreOfficeMissingError(error);
      // 管理员报错管理：解析失败落库（LibreOffice 缺失记 warn，其余记 error）
      void recordErrorLog(prisma, {
        userId: getUser(req).id,
        level: isOfficeMissing ? 'warn' : 'error',
        source: 'parse',
        summary: '文件解析失败：' + message.slice(0, 300),
        statusCode: isOfficeMissing ? 415 : 422,
        detail: { fileName, code: (error as Error & { code?: string })?.code },
      });
      return reply.code(isOfficeMissing ? 415 : 422).send({
        error: message,
        code: (error as Error & { code?: string })?.code || 'parse_failed',
        fileName,
        officeBackendMissing: isOfficeMissing,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
