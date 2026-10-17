// 字数额度路由（受保护，按当前登录用户隔离）。
// GET  /quota            → 余额 + 套餐列表
// POST /quota/orders     → 创建充值订单（pending；网关接入前由管理员人工核验）
// GET  /quota/orders     → 我的近期订单
// POST /quota/orders/:id/paid → 仅管理员：人工核验入账（幂等）
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getUser } from '../auth/middleware';
import { createRateLimit } from '../auth/rateLimit';
import { listAdminAuditLogs } from '../audit/service';
import {
  QUOTA_PLANS,
  adjustUserQuotaChars,
  createQuotaOrder,
  deductQuotaChars,
  findQuotaPlan,
  getQuotaChars,
  getRebateConfig,
  isQuotaChannel,
  listQuotaConsumeLogs,
  listQuotaOrders,
  markQuotaOrderPaid,
  saveRebateConfig,
} from '../quota/service';

export async function quotaRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const orderCreateRateLimit = createRateLimit({ name: 'quota-order-create', windowMs: 60_000, max: 10, keyBy: 'user' });

  app.get('/quota', async (req) => {
    const userId = getUser(req).id;
    return {
      quotaChars: await getQuotaChars(prisma, userId),
      plans: QUOTA_PLANS,
    };
  });

  app.post('/quota/orders', { onRequest: orderCreateRateLimit }, async (req, reply) => {
    const userId = getUser(req).id;
    const body = (req.body ?? {}) as { planKey?: unknown; channel?: unknown };
    const plan = findQuotaPlan(body.planKey);
    if (!plan) {
      return reply.code(400).send({ error: '无效的充值套餐' });
    }
    if (!isQuotaChannel(body.channel)) {
      return reply.code(400).send({ error: '无效的支付渠道' });
    }
    const result = await createQuotaOrder(prisma, userId, plan, body.channel);
    return result;
  });

  app.get('/quota/orders', async (req) => {
    const userId = getUser(req).id;
    return { orders: await listQuotaOrders(prisma, userId) };
  });

  // GET /quota/consume-logs?userId= → 消费流水（本人自查；管理员可带 userId 查任意用户）
  app.get('/quota/consume-logs', async (req, reply) => {
    const user = getUser(req);
    const query = (req.query as { userId?: string }).userId;
    let targetUserId = user.id;
    if (query !== undefined) {
      if (user.role !== 'admin') {
        return reply.code(403).send({ error: '仅管理员可查询他人消费流水' });
      }
      targetUserId = Number(query);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return reply.code(400).send({ error: '无效的 userId' });
      }
    }
    return { logs: await listQuotaConsumeLogs(prisma, targetUserId) };
  });

  // GET /quota/rebate-config → 返利配置（管理员；登录用户返回默认占位亦可——仅管理员可改）
  app.get('/quota/rebate-config', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看返利配置' });
    }
    return await getRebateConfig(prisma);
  });

  // PUT /quota/rebate-config → 仅管理员：维护返利比例与冻结周期（API-25/26 前置配置）
  app.put('/quota/rebate-config', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可修改返利配置' });
    }
    const body = (req.body ?? {}) as { rebatePercent?: unknown; freezeDays?: unknown };
    const input: { rebatePercent?: number; freezeDays?: number } = {};
    if (body.rebatePercent !== undefined) {
      const value = Number(body.rebatePercent);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return reply.code(400).send({ error: '返利比例必须是 0~100 的数字' });
      }
      input.rebatePercent = Math.floor(value);
    }
    if (body.freezeDays !== undefined) {
      const value = Number(body.freezeDays);
      if (!Number.isFinite(value) || value < 0) {
        return reply.code(400).send({ error: '冻结周期必须是不小于 0 的天数' });
      }
      input.freezeDays = Math.floor(value);
    }
    return await saveRebateConfig(prisma, input);
  });

  app.post('/quota/orders/:id/paid', async (req, reply) => {
    const user = getUser(req);
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

  // POST /quota/users/:id/adjust → 仅管理员：调整用户字数额度（增减/设为），写操作日志。
  app.post('/quota/users/:id/adjust', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可调整额度' });
    }
    const targetUserId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return reply.code(400).send({ error: '无效的用户 ID' });
    }
    const body = (req.body ?? {}) as { deltaChars?: unknown; setChars?: unknown; remark?: unknown };
    const input: { deltaChars?: number; setChars?: number; remark?: string } = {};
    if (body.setChars !== undefined && body.setChars !== null && body.setChars !== '') {
      const setChars = Number(body.setChars);
      if (!Number.isFinite(setChars) || setChars < 0) {
        return reply.code(400).send({ error: '目标余额必须是不小于 0 的数字' });
      }
      input.setChars = setChars;
    }
    if (body.deltaChars !== undefined && body.deltaChars !== null && body.deltaChars !== '') {
      const deltaChars = Number(body.deltaChars);
      if (!Number.isFinite(deltaChars) || deltaChars === 0) {
        return reply.code(400).send({ error: '增减字数必须是 非0 数字' });
      }
      input.deltaChars = Math.round(deltaChars);
    }
    if (input.setChars === undefined && input.deltaChars === undefined) {
      return reply.code(400).send({ error: '请填写调整字数' });
    }
    if (typeof body.remark === 'string' && body.remark.trim()) {
      input.remark = body.remark.trim().slice(0, 200);
    }
    const result = await adjustUserQuotaChars(prisma, user.id, targetUserId, input);
    if (!result.ok) {
      return reply.code(400).send({ error: result.message || '调整失败' });
    }
    return { success: true, before: result.before, after: result.after, delta: result.delta };
  });

  // GET /quota/adjust-logs?userId= → 仅管理员：某用户的管理员调整/操作记录。
  app.get('/quota/adjust-logs', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看操作日志' });
    }
    const userId = Number((req.query as { userId?: string }).userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return reply.code(400).send({ error: '缺少有效的 userId' });
    }
    return { logs: await listAdminAuditLogs(prisma, userId) };
  });
}

// 导出扣费：仅供 routes/export.ts 在导出成功后调用。余额不足时抛带结构化信息的错误，
// 路由层转成 402 响应（前端据此弹出充值窗口）。
export class QuotaInsufficientError extends Error {
  readonly required: number;
  readonly balance: number;
  constructor(required: number, balance: number) {
    super(`字数额度不足：本次导出 ${required} 字，当前余额 ${balance} 字`);
    this.name = 'QuotaInsufficientError';
    this.required = required;
    this.balance = balance;
  }
}

export async function chargeExportQuota(prisma: PrismaClient, userId: number, chars: number): Promise<number> {
  if (!(chars > 0)) return 0;
  const result = await deductQuotaChars(prisma, userId, chars);
  if (!result.ok) {
    throw new QuotaInsufficientError(chars, result.balance);
  }
  return result.charged;
}
