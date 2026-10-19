// 字数额度路由（受保护，按当前登录用户隔离）。
// GET  /quota            → 余额 + 套餐列表
// POST /quota/orders     → 创建充值订单（pending；网关接入前由管理员人工核验）
// GET  /quota/orders     → 我的近期订单
// POST /quota/orders/:id/paid → 仅管理员：人工核验入账（幂等）
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getUser } from '../auth/middleware';
import { createRateLimit } from '../auth/rateLimit';
import { listAdminAuditLogs, writeAdminAudit } from '../audit/service';
import {
  adjustUserQuotaChars,
  createQuotaOrder,
  findQuotaPlan,
  getQuotaChars,
  getQuotaPricing,
  getSignupGrantChars,
  getRebateConfig,
  isQuotaChannel,
  listQuotaConsumeLogs,
  listQuotaOrders,
  markQuotaOrderPaid,
  saveQuotaPricing,
  saveRebateConfig,
} from '../quota/service';

export async function quotaRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const orderCreateRateLimit = createRateLimit({ name: 'quota-order-create', windowMs: 60_000, max: 10, keyBy: 'user' });

  app.get('/quota', async (req) => {
    const userId = getUser(req).id;
    return {
      quotaChars: await getQuotaChars(prisma, userId),
      // 套餐为管理员动态配置（quota_config 表），不再使用硬编码清单
      plans: (await getQuotaPricing(prisma)).plans,
    };
  });

  app.post('/quota/orders', { onRequest: orderCreateRateLimit }, async (req, reply) => {
    const userId = getUser(req).id;
    const body = (req.body ?? {}) as { planKey?: unknown; channel?: unknown };
    const plan = await findQuotaPlan(prisma, body.planKey);
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

  // GET /quota/pricing → 仅管理员：读取计费配置（充值套餐 + 注册赠送额度）
  app.get('/quota/pricing', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可查看计费配置' });
    }
    return await getQuotaPricing(prisma);
  });

  // PUT /quota/pricing → 仅管理员：动态调整充值套餐（价格+字数）与注册赠送额度
  app.put('/quota/pricing', async (req, reply) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可修改计费配置' });
    }
    const body = (req.body ?? {}) as { signupGrantChars?: unknown; plans?: unknown };
    try {
      const result = await saveQuotaPricing(prisma, {
        signupGrantChars: body.signupGrantChars,
        plans: body.plans,
      });
      return { success: true, message: '计费配置已保存', ...result };
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '计费配置保存失败' });
    }
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
      if (!Number.isFinite(value) || value < 0 || value > 3650) {
        return reply.code(400).send({ error: '冻结周期必须是 0~3650 的天数' });
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
    // 资金操作留痕：核验入账（含重复核验的早退）都记录操作人，出纠纷可追责。
    if (result.order) {
      await writeAdminAudit(prisma, user.id, result.order.userId, 'quota.order.paid', {
        orderId: result.order.id,
        outTradeNo: result.order.outTradeNo,
        chars: result.order.chars,
        amountCents: result.order.amountCents,
        alreadyPaid: result.order.alreadyPaid,
      });
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
    // 上限 20 亿：quotaChars 是 int4，超限值会让 Postgres 抛 "integer out of range" 变成 500。
    const QUOTA_VALUE_LIMIT = 2_000_000_000;
    if (body.setChars !== undefined && body.setChars !== null && body.setChars !== '') {
      const setChars = Number(body.setChars);
      if (!Number.isFinite(setChars) || setChars < 0) {
        return reply.code(400).send({ error: '目标余额必须是不小于 0 的数字' });
      }
      if (setChars > QUOTA_VALUE_LIMIT) {
        return reply.code(400).send({ error: '目标余额超出上限（20 亿字）' });
      }
      input.setChars = setChars;
    }
    if (body.deltaChars !== undefined && body.deltaChars !== null && body.deltaChars !== '') {
      const deltaChars = Number(body.deltaChars);
      if (!Number.isFinite(deltaChars) || deltaChars === 0) {
        return reply.code(400).send({ error: '增减字数必须是 非0 数字' });
      }
      if (Math.abs(deltaChars) > QUOTA_VALUE_LIMIT) {
        return reply.code(400).send({ error: '增减字数超出上限（20 亿字）' });
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

// 并发安全的导出计费（导出路由唯一入口）：
//   - 消费流水判重（同一用户同一内容指纹已有流水 → 免费导出；修复 A→B→A 来回导出重复扣费）
//   - 扣额度（条件更新，余额不足即抛 QuotaInsufficientError）
//   - 抢占项目级内容指纹（并发请求串行化的闸门；并发同内容只有一个能抢占成功）
//   - 落消费流水
// 全程同事务：任一失败整体回滚，不会出现"扣了钱没记流水"或"并发重复扣费"。
// 返回 alreadyBilled=true 表示同一内容已被计费（本次不扣、不记流水）。
class AlreadyBilledSignal extends Error {}

export async function chargeExportOnce(
  prisma: PrismaClient,
  args: { userId: number; projectId: number; chars: number; fingerprint: string; matchFingerprints?: string[] },
): Promise<{ alreadyBilled: boolean }> {
  const { userId, projectId, chars, fingerprint } = args;
  // 兼容历史指纹（字数参与哈希的旧格式）：任一命中都视为已计费，不重复扣。
  const matchFingerprints = [fingerprint, ...(Array.isArray(args.matchFingerprints) ? args.matchFingerprints : [])];
  // 不变量：0 字导出不得走"免费流水"路径（渲染口径与计数口径若不慎再次分叉，这里兜底）。
  if (!Number.isFinite(chars) || chars <= 0) {
    throw new Error('导出字数必须大于 0');
  }
  try {
    await prisma.$transaction(async (tx) => {
      // 流水判重（覆盖"非连续重复导出"）：项目行指纹只记住上一次计费的内容，
      // A→B→A 序列会让 A 第二次通过指纹抢占；查流水才能兑现"同内容不重复扣费"的承诺。
      const billed = await (tx as unknown as { quotaConsumeLog: { findFirst: (args: unknown) => Promise<unknown> } })
        .quotaConsumeLog.findFirst({ where: { userId, fingerprint: { in: matchFingerprints } }, select: { id: true } });
      if (billed) throw new AlreadyBilledSignal();
      if (chars > 0) {
        const deducted = await tx.user.updateMany({
          where: { id: userId, quotaChars: { gte: chars } },
          data: { quotaChars: { decrement: chars }, quotaUsedChars: { increment: chars } },
        });
        if (deducted.count === 0) {
          const row = await tx.user.findUnique({ where: { id: userId }, select: { quotaChars: true } });
          throw new QuotaInsufficientError(chars, row?.quotaChars ?? 0);
        }
      }
      // 原子占位：项目指纹已是相同内容 → 回滚本次扣减（并发同内容的串行闸门）。
      const claimed = await tx.project.updateMany({
        where: {
          id: projectId,
          OR: [{ quotaFingerprint: null }, { quotaFingerprint: { notIn: matchFingerprints } }],
        },
        data: { quotaFingerprint: fingerprint },
      });
      if (claimed.count === 0) throw new AlreadyBilledSignal();
      await (tx as unknown as { quotaConsumeLog: { create: (args: unknown) => Promise<unknown> } }).quotaConsumeLog.create({
        data: { userId, chars, projectId, fingerprint },
      });
    });
    return { alreadyBilled: false };
  } catch (error) {
    if (error instanceof AlreadyBilledSignal) return { alreadyBilled: true };
    throw error;
  }
}
