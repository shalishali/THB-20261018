import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';

// API-13：个人 AI 调用记录查询（FE-17 数据源）。
// GET /api/stats/ai-usage?days=30&page=1&pageSize=20
// 仅返回本人（user.id）数据（API-08 userId 隔离）；一期只读展示，不做扣费。
export async function statsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/stats/ai-usage', async (req: FastifyRequest, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const query = (req.query as Record<string, unknown>) || {};

    const days = Math.round(Number(query.days ?? 30));
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      reply.code(400);
      return { success: false, message: 'days 取值范围 1~366' };
    }
    const page = Math.round(Number(query.page ?? 1));
    const pageSize = Math.round(Number(query.pageSize ?? 20));
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100) {
      reply.code(400);
      return { success: false, message: 'page/pageSize 取值非法（pageSize 上限 100）' };
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // 一期个人记录量级小（天/周级几十条）：窗口内全量拉取后内存聚合，避免 groupBy/多查询。
    const rows = await prisma.aiCallStat.findMany({
      where: { userId: user.id, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, projectId: true, provider: true, model: true, bizType: true, callCount: true,
        inputTokens: true, outputTokens: true, inputChars: true, outputChars: true, createdAt: true,
      },
    });

    const totals = {
      calls: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0,
    };
    const byBizType: Record<string, { calls: number; inputChars: number; outputChars: number; inputTokens: number; outputTokens: number }> = {};
    for (const row of rows) {
      totals.calls += row.callCount;
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.inputChars += row.inputChars;
      totals.outputChars += row.outputChars;
      const bucket = (byBizType[row.bizType] ||= { calls: 0, inputChars: 0, outputChars: 0, inputTokens: 0, outputTokens: 0 });
      bucket.calls += row.callCount;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.inputChars += row.inputChars;
      bucket.outputChars += row.outputChars;
    }

    const start = (page - 1) * pageSize;
    return {
      days,
      page,
      pageSize,
      totalRows: rows.length,
      totals,
      byBizType,
      items: rows.slice(start, start + pageSize),
    };
  });
}
