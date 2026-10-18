// 错误记录服务（管理员报错管理）：汇聚用户使用过程中的报错（5xx/导出失败/解析失败/任务失败等）。
// 原则：
//  - 只存脱敏摘要与错误码（消息截断 500 字符），不存用户业务内容（招标文件/生成正文）
//  - 4xx 用户输入类错误不记（噪音），只记 5xx 与少数运营相关（402 额度不足 → warn）
//  - 写入 fire-and-forget：记录失败不影响主流程
//  - 保留 30 天，由每日定时清理
import type { PrismaClient } from '@prisma/client';

export interface ErrorLogInput {
  userId?: number | null;
  projectId?: number | null;
  level?: 'error' | 'warn';
  source: string; // api / export / parse / task / ai
  summary: string;
  statusCode?: number | null;
  detail?: Record<string, unknown>;
}

function cleanSummary(message: string): string {
  return String(message || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

export async function recordErrorLog(prisma: PrismaClient, input: ErrorLogInput): Promise<void> {
  try {
    await (prisma as any).errorLog.create({
      data: {
        userId: input.userId ?? null,
        projectId: input.projectId ?? null,
        level: input.level || 'error',
        source: input.source,
        summary: cleanSummary(input.summary),
        statusCode: input.statusCode ?? null,
        detail: (input.detail ?? undefined) as any,
      },
    });
  } catch (error) {
    console.error('[errorlog] 错误记录写入失败:', error instanceof Error ? error.message : error);
  }
}

export async function listErrorLogs(
  prisma: PrismaClient,
  filters: { level?: string; source?: string; userId?: number; resolved?: boolean; page: number; pageSize: number },
): Promise<{ total: number; unresolved: number; items: Record<string, unknown>[] }> {
  const where: any = {};
  if (filters.level) where.level = filters.level;
  if (filters.source) where.source = filters.source;
  if (filters.userId) where.userId = filters.userId;
  if (filters.resolved !== undefined) where.resolved = filters.resolved;

  const [total, unresolved, rows] = await Promise.all([
    (prisma as any).errorLog.count({ where }),
    (prisma as any).errorLog.count({ where: { ...where, resolved: false } }),
    (prisma as any).errorLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: { user: { select: { username: true, displayName: true } } },
    }),
  ]);

  return {
    total,
    unresolved,
    items: rows.map((row: any) => ({
      id: row.id,
      userId: row.userId,
      username: row.user?.displayName || row.user?.username || (row.userId ? `#${row.userId}` : '匿名'),
      projectId: row.projectId,
      level: row.level,
      source: row.source,
      summary: row.summary,
      statusCode: row.statusCode,
      resolved: row.resolved,
      createdAt: row.createdAt,
    })),
  };
}

export async function markErrorLogResolved(prisma: PrismaClient, id: number): Promise<{ ok: boolean; message: string }> {
  const updated = await (prisma as any).errorLog.updateMany({
    where: { id, resolved: false },
    data: { resolved: true },
  });
  if (updated.count === 0) return { ok: false, message: '记录不存在或已处理' };
  return { ok: true, message: '已标记处理' };
}

// 保留期清理（默认 30 天）：挂在每日定时器上。
export async function cleanupOldErrorLogs(prisma: PrismaClient, days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  try {
    const result = await (prisma as any).errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return result.count;
  } catch {
    return 0;
  }
}
