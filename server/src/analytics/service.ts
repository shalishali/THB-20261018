// 站点分析服务（自研轻量版，不依赖第三方统计）：
// - 访问记录（匿名/登录均记）
// - 用户操作记录（登录/注册/建项目/导入/启动任务/导出等关键动作）
// - 最近活跃节流写入（≥10 分钟才更新一次 lastActiveAt，避免每请求落库）
// - 管理端概览：访问/登录/注册/活跃/未活跃
import type { PrismaClient } from '@prisma/client';

const LAST_ACTIVE_THROTTLE_MS = 10 * 60 * 1000;
const lastActiveWritten = new Map<number, number>();

export async function trackVisit(
  prisma: PrismaClient,
  input: { userId?: number | null; ip: string; ua?: string; path?: string },
): Promise<void> {
  try {
    await (prisma as any).visitLog.create({
      data: {
        userId: input.userId ?? null,
        ip: input.ip.slice(0, 64),
        ua: input.ua?.slice(0, 300) || null,
        path: input.path?.slice(0, 200) || null,
      },
    });
  } catch (error) {
    console.error('[analytics] 访问记录写入失败:', error instanceof Error ? error.message : error);
  }
}

export async function trackActivity(
  prisma: PrismaClient,
  userId: number,
  action: string,
  detail?: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  try {
    await (prisma as any).activityLog.create({
      data: {
        userId,
        action,
        detail: (detail ?? undefined) as any,
        ip: ip?.slice(0, 64) || null,
      },
    });
  } catch (error) {
    console.error('[analytics] 操作记录写入失败:', error instanceof Error ? error.message : error);
  }
}

// 节流更新 lastActiveAt：内存 Map 判断距上次写入是否超过 10 分钟。
// 整体 try/catch 兜底：活跃时间写失败绝不影响业务请求。
export function touchLastActiveThrottled(prisma: PrismaClient, userId: number): void {
  try {
    const now = Date.now();
    const last = lastActiveWritten.get(userId) || 0;
    if (now - last < LAST_ACTIVE_THROTTLE_MS) return;
    lastActiveWritten.set(userId, now);
    void prisma.user
      .update({ where: { id: userId }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);
  } catch {
    /* 活跃时间更新失败不影响主流程 */
  }
}

export interface AnalyticsOverview {
  range: { days: number };
  visits: number;
  uniqueVisitors: number;
  logins: number;
  registrations: number;
  activeUsers: number;
  totalUsers: number;
  inactiveUsers: number;
  exports: number;
  aiCalls: number;
  series: Array<{ date: string; visits: number; logins: number; registrations: number }>;
}

// 管理端概览：近 N 天访问/登录/注册日序列 + 活跃/未活跃用户数。
// 日序列用原生 SQL DATE_TRUNC 聚合（Postgres）。
export async function getAnalyticsOverview(prisma: PrismaClient, days: number): Promise<AnalyticsOverview> {
  const rangeDays = Math.min(Math.max(days, 1), 90);
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

  const [visits, uniqueVisitors, logins, registrations, exports, aiCalls, totalUsers, inactiveUsers, series] = await Promise.all([
    (prisma as any).visitLog.count({ where: { createdAt: { gte: since } } }),
    (prisma as any).visitLog.findMany({ where: { createdAt: { gte: since }, userId: { not: null } }, distinct: ['userId'], select: { userId: true } }),
    (prisma as any).activityLog.count({ where: { createdAt: { gte: since }, action: 'login' } }),
    (prisma as any).activityLog.count({ where: { createdAt: { gte: since }, action: 'register' } }),
    (prisma as any).activityLog.count({ where: { createdAt: { gte: since }, action: 'export' } }),
    (prisma as any).aiCallStat.aggregate({ where: { createdAt: { gte: since } }, _sum: { callCount: true } }),
    prisma.user.count(),
    prisma.user.count({
      where: {
        role: { not: 'admin' },
        OR: [
          { lastActiveAt: null },
          { lastActiveAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        ],
      },
    }),
    prisma.$queryRaw<Array<{ day: Date; visits: bigint; logins: bigint; registrations: bigint }>>`
      SELECT d.day::date,
             COALESCE(v.cnt, 0) AS visits,
             COALESCE(l.cnt, 0) AS logins,
             COALESCE(r.cnt, 0) AS registrations
      FROM generate_series(${since}::date, CURRENT_DATE, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS cnt
        FROM "visit_logs" WHERE "createdAt" >= ${since} GROUP BY 1
      ) v ON v.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS cnt
        FROM "activity_logs" WHERE "createdAt" >= ${since} AND action = 'login' GROUP BY 1
      ) l ON l.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS cnt
        FROM "activity_logs" WHERE "createdAt" >= ${since} AND action = 'register' GROUP BY 1
      ) r ON r.day = d.day
      ORDER BY d.day`,
  ]);

  return {
    range: { days: rangeDays },
    visits,
    uniqueVisitors: uniqueVisitors.length,
    logins,
    registrations,
    activeUsers: Math.max(0, totalUsers - inactiveUsers),
    totalUsers,
    inactiveUsers,
    exports,
    aiCalls: Number((aiCalls as any)?._sum?.callCount || 0),
    series: series.map((row) => ({
      date: new Date(row.day).toISOString().slice(0, 10),
      visits: Number(row.visits),
      logins: Number(row.logins),
      registrations: Number(row.registrations),
    })),
  };
}

export async function listActivityLogs(
  prisma: PrismaClient,
  filters: { userId?: number; action?: string; page: number; pageSize: number },
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const where: any = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.action) where.action = filters.action;
  const [total, rows] = await Promise.all([
    (prisma as any).activityLog.count({ where }),
    (prisma as any).activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: { user: { select: { username: true, displayName: true } } },
    }),
  ]);
  return {
    total,
    items: rows.map((row: any) => ({
      id: row.id,
      userId: row.userId,
      username: row.user?.displayName || row.user?.username || `#${row.userId}`,
      action: row.action,
      detail: row.detail,
      ip: row.ip,
      createdAt: row.createdAt,
    })),
  };
}

// 未活跃用户列表：注册后从未活跃或最近 7 天（可配）无活跃的普通用户。
export async function listInactiveUsers(
  prisma: PrismaClient,
  days = 7,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const rows = await prisma.user.findMany({
    where: {
      role: { not: 'admin' },
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: {
      id: true, username: true, displayName: true, phone: true, createdAt: true,
      lastActiveAt: true, quotaChars: true, quotaUsedChars: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    phone: row.phone,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    quotaChars: row.quotaChars,
    quotaUsedChars: row.quotaUsedChars,
  }));
}
