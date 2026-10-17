// 站点分析路由（拆两个插件：公开埋点 + 受保护管理端）。
// POST /analytics/visit          → 公开访问埋点（登录页匿名也计；轻量 IP 限流防刷）
// GET  /analytics/overview       → 仅管理员：近 N 天访问/登录/注册/活跃概览 + 日序列
// GET  /analytics/activity       → 仅管理员：用户操作记录（可按 userId/action 过滤，分页）
// GET  /analytics/inactive       → 仅管理员：注册后未活跃（或超 N 天无活跃）用户列表
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { createRateLimit, clientIp } from '../auth/rateLimit';
import { getAnalyticsOverview, listActivityLogs, listInactiveUsers, trackVisit } from '../analytics/service';
import { listErrorLogs, markErrorLogResolved } from '../errorlog/service';

// 公开：访问埋点（匿名按 IP 记；携带有效 Bearer token 则归到该用户）
export async function analyticsVisitRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const visitRateLimit = createRateLimit({ name: 'analytics-visit', windowMs: 60_000, max: 60, keyBy: 'ip' });

  app.post('/analytics/visit', { onRequest: visitRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown };
    let userId: number | null = null;
    const authHeader = req.headers.authorization;
    // best-effort 解析登录身份：无效/过期 token 按匿名记录，不影响埋点
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || '') as { id?: number };
        if (typeof payload.id === 'number') userId = payload.id;
      } catch {
        /* 匿名访问 */
      }
    }
    await trackVisit(prisma, {
      userId,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || ''),
      path: typeof body.path === 'string' ? body.path.slice(0, 200) : undefined,
    });
    return { success: true };
  });
}

// 管理端（挂在受保护区，verifyToken 已注入 req.user）
export async function analyticsAdminRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // 管理员：概览
  app.get('/analytics/overview', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看站点分析' });
    }
    const days = Number((req.query as { days?: string }).days ?? 7);
    return await getAnalyticsOverview(prisma, Number.isFinite(days) ? days : 7);
  });

  // 管理员：操作记录分页
  app.get('/analytics/activity', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看操作记录' });
    }
    const query = (req.query as { userId?: string; action?: string; page?: string; pageSize?: string }) || {};
    const page = Math.max(1, Math.round(Number(query.page ?? 1)) || 1);
    const pageSize = Math.min(Math.max(Math.round(Number(query.pageSize ?? 20)) || 20, 1), 100);
    const result = await listActivityLogs(prisma, {
      userId: query.userId ? Number(query.userId) : undefined,
      action: query.action || undefined,
      page,
      pageSize,
    });
    return result;
  });

  // 管理员：未活跃用户列表
  app.get('/analytics/inactive', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看未活跃用户' });
    }
    const days = Number((req.query as { days?: string }).days ?? 7);
    return { users: await listInactiveUsers(prisma, Number.isFinite(days) ? days : 7) };
  });

  // 管理员：错误记录分页（level=error/warn；source=api/export/parse/task；resolved=true/false）
  app.get('/analytics/errors', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看错误记录' });
    }
    const query = (req.query as { level?: string; source?: string; resolved?: string; userId?: string; page?: string; pageSize?: string }) || {};
    const page = Math.max(1, Math.round(Number(query.page ?? 1)) || 1);
    const pageSize = Math.min(Math.max(Math.round(Number(query.pageSize ?? 20)) || 20, 1), 100);
    const result = await listErrorLogs(prisma, {
      level: query.level || undefined,
      source: query.source || undefined,
      userId: query.userId ? Number(query.userId) : undefined,
      resolved: query.resolved === undefined || query.resolved === '' ? undefined : query.resolved === 'true',
      page,
      pageSize,
    });
    return result;
  });

  // 管理员：标记错误已处理
  app.post('/analytics/errors/:id/resolve', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可处理错误记录' });
    }
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的记录 ID' });
    }
    const result = await markErrorLogResolved(prisma, id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.message });
    }
    return { success: true, message: result.message };
  });
}
