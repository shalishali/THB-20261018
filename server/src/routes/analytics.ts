// 站点分析路由（拆两个插件：公开埋点 + 受保护管理端）。
// POST /analytics/visit          → 公开访问埋点（登录页匿名也计；轻量 IP 限流防刷）
// GET  /analytics/overview       → 仅管理员：近 N 天访问/登录/注册/活跃概览 + 日序列
// GET  /analytics/activity       → 仅管理员：用户操作记录（可按 userId/action 过滤，分页）
// GET  /analytics/inactive       → 仅管理员：注册后未活跃（或超 N 天无活跃）用户列表
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { verifyAccessToken } from '../auth/middleware';
import { createRateLimit, clientIp } from '../auth/rateLimit';
import { getAnalyticsOverview, listActivityLogs, listInactiveUsers, trackVisit } from '../analytics/service';
import { listErrorLogs, markErrorLogResolved } from '../errorlog/service';
import { listQuotaOrders, markQuotaOrderPaid, listQuotaConsumeLogs } from '../quota/service';

// 公开：访问埋点（匿名按 IP 记；携带有效 Bearer token 则归到该用户）
export async function analyticsVisitRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const visitRateLimit = createRateLimit({ name: 'analytics-visit', windowMs: 60_000, max: 60, keyBy: 'ip' });

  app.post('/analytics/visit', { onRequest: visitRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown };
    let userId: number | null = null;
    const authHeader = req.headers.authorization;
    // best-effort 解析登录身份：无效/过期/已吊销 token 按匿名记录，不影响埋点。
    // 用 verifyAccessToken（拒绝 initial-password-change 用途令牌）+ 回查 tokenVersion，
    // 此前裸 jwt.verify 会把已改密吊销的旧 token 也归因到用户。
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyAccessToken(authHeader.slice(7));
        const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { tokenVersion: true } });
        if (user && (payload.tokenVersion ?? 0) === user.tokenVersion) {
          userId = payload.id;
        }
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

  // 管理员：项目各步骤耗时详情（仪表盘「详细情况」）
  // 数据来源：project.createdAt / technical_plan_meta.tenderImportedAt / technical_plan_tasks 的 startedAt+updatedAt。
  app.get('/analytics/project-timeline', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看项目步骤耗时' });
    }
    const projectId = Number((req.query as { projectId?: string }).projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return reply.code(400).send({ error: '缺少有效的 projectId' });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, name: true, projectCode: true, createdAt: true, updatedAt: true, lastExportedAt: true,
        owner: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    const meta = await prisma.technicalPlanMeta.findUnique({
      where: { projectId },
      select: { tenderImportedAt: true, tenderFileName: true, step: true },
    });
    const tasks = await prisma.technicalPlanTask.findMany({
      where: { projectId },
      select: { type: true, status: true, startedAt: true, updatedAt: true, error: true },
    });
    const taskMap = new Map(tasks.map((task) => [task.type, task]));
    const toTime = (value: string | Date | null | undefined): number | null => {
      if (!value) return null;
      const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
      return Number.isFinite(time) ? time : null;
    };
    const buildStep = (key: string, label: string, startValue: string | Date | null | undefined, endValue: string | Date | null | undefined, status: string, note: string) => {
      const start = toTime(startValue);
      const end = toTime(endValue);
      return {
        key,
        label,
        startAt: start != null ? new Date(start).toISOString() : '',
        endAt: end != null ? new Date(end).toISOString() : '',
        durationMs: start != null && end != null && end >= start ? end - start : null,
        status,
        note,
      };
    };
    const uploadStart = project.createdAt;
    const uploadEnd = meta?.tenderImportedAt || null;
    const taskStep = (type: string, key: string, label: string, pendingNote: string) => {
      const task = taskMap.get(type);
      if (!task) return buildStep(key, label, null, null, 'pending', pendingNote);
      const status = task.status === 'success' ? 'done' : task.status;
      const note = task.status === 'success'
        ? '任务已完成'
        : task.status === 'error'
          ? (task.error || '任务失败')
          : task.status === 'running'
            ? '任务进行中'
            : pendingNote;
      return buildStep(key, label, task.startedAt, task.updatedAt, status, note);
    };
    const steps = [
      buildStep('upload', 'STEP 01 上传招标文件', uploadStart, uploadEnd, uploadEnd ? 'done' : 'pending', meta?.tenderFileName || '未上传招标文件'),
      taskStep('bid-analysis', 'bid-analysis', 'STEP 02 招标文件解析', '未开始解析'),
      taskStep('outline-generation', 'outline-generation', 'STEP 03 目录生成', '未开始生成目录'),
      taskStep('global-facts-generation', 'global-facts-generation', 'STEP 04 全局事实设定', '未开始生成全局事实'),
      taskStep('content-generation', 'content-generation', 'STEP 05 正文生成', '未开始生成正文'),
      buildStep('export', 'STEP 06 导出 Word（最近一次）', taskMap.get('content-generation')?.updatedAt || null, project.lastExportedAt, project.lastExportedAt ? 'done' : 'pending', project.lastExportedAt ? '最近一次成功导出时间' : '尚未导出'),
    ];
    const totalStart = toTime(project.createdAt);
    const totalEnd = toTime(project.lastExportedAt || project.updatedAt);
    return {
      project: {
        id: project.id,
        name: project.name,
        projectCode: project.projectCode,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        lastExportedAt: project.lastExportedAt ? project.lastExportedAt.toISOString() : '',
        ownerName: project.owner?.displayName?.trim() || project.owner?.username || '',
      },
      steps,
      totalDurationMs: totalStart != null && totalEnd != null && totalEnd >= totalStart ? totalEnd - totalStart : null,
      generatedAt: new Date().toISOString(),
    };
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

  // GET /analytics/orders → 仅管理员：全量充值订单（含用户名），支持状态过滤
  app.get('/analytics/orders', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看充值订单' });
    }
    const query = (req.query as { status?: string; page?: string; pageSize?: string }) || {};
    const page = Math.max(1, Math.round(Number(query.page ?? 1)) || 1);
    const pageSize = Math.min(Math.max(Math.round(Number(query.pageSize ?? 20)) || 20, 1), 100);
    const where: any = {};
    if (query.status) where.status = query.status;
    const [total, rows] = await Promise.all([
      (prisma as any).quotaOrder.count({ where }),
      (prisma as any).quotaOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { username: true, displayName: true } } },
      }),
    ]);
    return {
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        username: row.user?.displayName || row.user?.username || `#${row.userId}`,
        planKey: row.planKey,
        chars: row.chars,
        amountCents: row.amountCents,
        channel: row.channel,
        status: row.status,
        outTradeNo: row.outTradeNo,
        createdAt: row.createdAt,
      })),
      page,
      pageSize,
    };
  });

  // POST /analytics/orders/:id/verify → 仅管理员：核验充值订单（等价于 markQuotaOrderPaid）
  app.post('/analytics/orders/:id/verify', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可核验订单' });
    }
    const orderId = (req.params as { id?: string }).id || '';
    const result = await markQuotaOrderPaid(prisma, orderId);
    if (!result.ok) {
      return reply.code(400).send({ error: result.message });
    }
    return { success: true, message: result.message };
  });

  // GET /analytics/consume-logs → 仅管理员：全量消费流水（含用户名）
  app.get('/analytics/consume-logs', async (req, reply) => {
    const user = (req as FastifyRequest & { user: { id: number; role: string } }).user;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看消费流水' });
    }
    const query = (req.query as { page?: string; pageSize?: string }) || {};
    const page = Math.max(1, Math.round(Number(query.page ?? 1)) || 1);
    const pageSize = Math.min(Math.max(Math.round(Number(query.pageSize ?? 20)) || 20, 1), 100);
    const [total, rows] = await Promise.all([
      (prisma as any).quotaConsumeLog.count(),
      (prisma as any).quotaConsumeLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { username: true, displayName: true } } },
      }),
    ]);
    return {
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        username: row.user?.displayName || row.user?.username || `#${row.userId}`,
        chars: row.chars,
        projectId: row.projectId,
        createdAt: row.createdAt,
      })),
      page,
      pageSize,
    };
  });
}
