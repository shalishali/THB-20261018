// 字数额度服务：注册赠送、导出扣减、充值订单。
// 计费口径与正文统计一致：非空白字符数（contentStats.totalWords 同源）。
// 支付网关（支付宝/微信）需要商户资质后接入：一期先落订单与状态流转，
// 管理员可经 POST /quota/orders/:id/paid 人工核验充值（线下转账/收款码场景）。
import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

export interface QuotaPlan {
  key: string;
  chars: number;
  amountCents: number; // 分，避免浮点
  label: string;
}

export const QUOTA_PLANS: QuotaPlan[] = [
  { key: 'plan-10w', chars: 100000, amountCents: 290, label: '10 万字' },
  { key: 'plan-20w', chars: 200000, amountCents: 500, label: '20 万字' },
  { key: 'plan-50w', chars: 500000, amountCents: 1000, label: '50 万字' },
  { key: 'plan-60w', chars: 600000, amountCents: 2000, label: '60 万字' },
];

export const QUOTA_CHANNELS = ['alipay', 'wechat'] as const;
export type QuotaChannel = (typeof QUOTA_CHANNELS)[number];

export function findQuotaPlan(planKey: unknown): QuotaPlan | null {
  if (typeof planKey !== 'string') return null;
  return QUOTA_PLANS.find((plan) => plan.key === planKey) || null;
}

export function isQuotaChannel(channel: unknown): channel is QuotaChannel {
  return typeof channel === 'string' && (QUOTA_CHANNELS as readonly string[]).includes(channel);
}

export async function getQuotaChars(prisma: PrismaClient, userId: number): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { quotaChars: true } });
  return user?.quotaChars ?? 0;
}

// 统计导出大纲的正文字数（非空白字符），口径与 contentStats.totalWords 一致。
/** 剥离 Markdown 语法符号后统计可读字数（与用户在正文面板看到的字数一致）。
 *  剥离规则：围栏代码块、Markdown 图片、链接语法（保留链接文字）、标题#/加粗**/斜体*、
 *  无序列表-、表格分隔线|---|、引用>、行内代码`。 */
function countReadableChars(content: string): number {
  return content
    .replace(/```[\s\S]*?```/g, '\n')                  // 围栏代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')              // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // 链接（保留文字）
    .replace(/^#{1,6}\s+/gm, '')                        // 标题符号
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                 // 加粗
    .replace(/(\*|_)(.*?)\1/g, '$2')                    // 斜体
    .replace(/^[-*+]\s+/gm, '')                         // 无序列表符号
    .replace(/^\d+\.\s+/gm, '')                         // 有序列表符号
    .replace(/^>\s+/gm, '')                             // 引用
    .replace(/`([^`]+)`/g, '$1')                        // 行内代码
    .replace(/\|/g, '')                                 // 表格分隔
    .replace(/[-=]{3,}/g, '')                           // 水平线/表格分隔线
    .replace(/\s/g, '')
    .length;
}

export function countOutlineContentChars(items: unknown): number {
  let sum = 0;
  const walk = (nodes: any[]): void => {
    for (const node of nodes || []) {
      const content = node?.content;
      if (typeof content === 'string') sum += countReadableChars(content);
      if (node?.children?.length) walk(node.children);
    }
  };
  walk(Array.isArray(items) ? (items as any[]) : []);
  return sum;
}

export interface QuotaDeductResult {
  ok: boolean;
  charged: number;
  balance: number;
}

// 原子扣减：条件更新保证余额不足时扣不动（并发导出也安全）；同步累计已用字数。
export async function deductQuotaChars(prisma: PrismaClient, userId: number, chars: number): Promise<QuotaDeductResult> {
  if (!(chars > 0)) {
    const balance = await getQuotaChars(prisma, userId);
    return { ok: true, charged: 0, balance };
  }
  const updated = await prisma.user.updateMany({
    where: { id: userId, quotaChars: { gte: chars } },
    data: { quotaChars: { decrement: chars }, quotaUsedChars: { increment: chars } },
  });
  if (updated.count === 0) {
    const balance = await getQuotaChars(prisma, userId);
    return { ok: false, charged: 0, balance };
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { quotaChars: true } });
  return { ok: true, charged: chars, balance: user?.quotaChars ?? 0 };
}

// DB-17：导出消费流水（扣费成功后落一笔，支撑消耗流水查询与对账）
export async function recordQuotaConsumeLog(
  prisma: PrismaClient,
  userId: number,
  chars: number,
  opts: { projectId?: number; fingerprint?: string } = {},
): Promise<void> {
  try {
    await (prisma as any).quotaConsumeLog.create({
      data: { userId, chars, projectId: opts.projectId ?? null, fingerprint: opts.fingerprint ?? null },
    });
  } catch (error) {
    console.error('[quota] 消费流水写入失败:', error instanceof Error ? error.message : error);
  }
}

export async function listQuotaConsumeLogs(prisma: PrismaClient, userId: number, limit = 20): Promise<Record<string, unknown>[]> {
  const rows = await (prisma as any).quotaConsumeLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map((row: any) => ({
    id: row.id,
    chars: row.chars,
    projectId: row.projectId,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  }));
}

export interface QuotaAdjustInput {
  /** 增减字数（可负） */
  deltaChars?: number;
  /** 直接设置为指定余额 */
  setChars?: number;
  remark?: string;
}

export interface QuotaAdjustResult {
  ok: boolean;
  message?: string;
  before?: number;
  after?: number;
  delta?: number;
}

// 管理员调整额度：支持"增减"或"设为"两种语义；余额下限 0；调整写入管理员操作日志。
export async function adjustUserQuotaChars(
  prisma: PrismaClient,
  adminId: number,
  targetUserId: number,
  input: QuotaAdjustInput,
): Promise<QuotaAdjustResult> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, quotaChars: true, quotaUsedChars: true },
  });
  if (!target) {
    return { ok: false, message: '目标用户不存在' };
  }
  const before = target.quotaChars;
  let after: number;
  if (typeof input.setChars === 'number' && Number.isFinite(input.setChars)) {
    after = Math.max(0, Math.floor(input.setChars));
  } else if (typeof input.deltaChars === 'number' && Number.isFinite(input.deltaChars) && input.deltaChars !== 0) {
    after = Math.max(0, before + Math.floor(input.deltaChars));
  } else {
    return { ok: false, message: '请填写要增减的字数或目标余额' };
  }
  const delta = after - before;
  if (delta === 0) {
    return { ok: false, message: '调整前后余额相同，无需调整' };
  }
  await prisma.user.update({ where: { id: targetUserId }, data: { quotaChars: after } });
  const { writeAdminAudit } = await import('../audit/service');
  await writeAdminAudit(prisma, adminId, targetUserId, 'quota.adjust', {
    targetUsername: target.username,
    before,
    after,
    delta,
    remark: String(input.remark || '').slice(0, 200),
  });
  return { ok: true, before, after, delta };
}

function buildOutTradeNo(): string {
  return `Q${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
}

// 支付网关是否已配置（支付宝当面付/微信 Native 的商户凭证走 env；未配置时订单停留在 pending，
// 由管理员人工核验）。接入网关后在此分支返回下单 payload（二维码链接等）。
export function isPaymentGatewayConfigured(): boolean {
  return Boolean(process.env.PAYMENT_ALIPAY_APP_ID?.trim() || process.env.PAYMENT_WECHAT_MCH_ID?.trim());
}

export async function createQuotaOrder(
  prisma: PrismaClient,
  userId: number,
  plan: QuotaPlan,
  channel: QuotaChannel,
): Promise<Record<string, unknown>> {
  const gatewayReady = isPaymentGatewayConfigured();
  const order = await prisma.quotaOrder.create({
    data: {
      userId,
      planKey: plan.key,
      chars: plan.chars,
      amountCents: plan.amountCents,
      channel,
      status: 'pending',
      outTradeNo: buildOutTradeNo(),
      // TODO：接入支付宝当面付/微信 Native 后，此处落网关下单返回的二维码/跳转链接
      payUrl: null,
    },
  });
  return {
    order: {
      id: order.id,
      outTradeNo: order.outTradeNo,
      planKey: order.planKey,
      chars: order.chars,
      amountCents: order.amountCents,
      channel: order.channel,
      status: order.status,
      createdAt: order.createdAt,
    },
    gatewayReady,
  };
}

export async function listQuotaOrders(prisma: PrismaClient, userId: number, limit = 10): Promise<Record<string, unknown>[]> {
  const rows = await prisma.quotaOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return rows.map((row) => ({
    id: row.id,
    outTradeNo: row.outTradeNo,
    planKey: row.planKey,
    chars: row.chars,
    amountCents: row.amountCents,
    channel: row.channel,
    status: row.status,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  }));
}

// 管理员人工核验：pending → paid 并入账（幂等：已 paid 直接返回，不重复加额度）。
// 入账成功后按返利配置给邀请人创建冻结返利流水（API-25/26：比例可配 + 冻结周期防套利）。
export async function markQuotaOrderPaid(prisma: PrismaClient, orderId: string): Promise<{ ok: boolean; message: string }> {
  const order = await prisma.quotaOrder.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, message: '订单不存在' };
  if (order.status === 'paid') return { ok: true, message: '订单已核验过，额度未重复入账' };
  const updated = await prisma.quotaOrder.updateMany({
    where: { id: orderId, status: 'pending' },
    data: { status: 'paid', paidAt: new Date() },
  });
  if (updated.count === 0) return { ok: false, message: '订单状态已变化，请刷新后重试' };
  await prisma.user.update({ where: { id: order.userId }, data: { quotaChars: { increment: order.chars } } });
  await settleRebateForPaidOrder(prisma, order.userId, order.outTradeNo, order.amountCents);
  return { ok: true, message: `已核验并入账 ${order.chars} 字额度` };
}

// API-25/26：被邀请人付费订单核验后，按全局比例给邀请人生成"冻结"返利流水；
// 冻结到期（freezeUntil）后由二期结算任务/人工置为 settled；退款扣回（refundClawback）预留。
async function settleRebateForPaidOrder(prisma: PrismaClient, payerUserId: number, outTradeNo: string, amountCents: number): Promise<void> {
  try {
    const config = await (prisma as any).rebateConfig.findUnique({ where: { id: 1 } });
    const percent = Math.max(0, Math.min(100, Number(config?.rebatePercent ?? 40)));
    const freezeDays = Math.max(0, Number(config?.freezeDays ?? 30));
    if (percent <= 0 || amountCents <= 0) return;
    const relation = await (prisma as any).inviteRelation.findUnique({ where: { inviteeId: payerUserId }, select: { inviterId: true } });
    if (!relation?.inviterId || relation.inviterId === payerUserId) return;
    const exists = await (prisma as any).rebateFlow.findFirst({ where: { sourceOrderId: outTradeNo }, select: { id: true } });
    if (exists) return; // 幂等：同一订单只生成一次返利
    const amountYuan = (amountCents * percent) / 100 / 100; // 分 → 元，再按比例
    const freezeUntil = freezeDays > 0 ? new Date(Date.now() + freezeDays * 24 * 60 * 60 * 1000) : null;
    await (prisma as any).rebateFlow.create({
      data: {
        inviterId: relation.inviterId,
        inviteeId: payerUserId,
        sourceType: 'order',
        sourceOrderId: outTradeNo,
        amount: amountYuan.toFixed(2),
        settleStatus: 'pending',
        freezeUntil,
      },
    });
  } catch (error) {
    console.error('[rebate] 返利流水生成失败（不影响订单核验）:', error instanceof Error ? error.message : error);
  }
}

// DB-19：返利配置读取（无记录时自动建默认 10% / 30 天）
export async function getRebateConfig(prisma: PrismaClient): Promise<{ rebatePercent: number; freezeDays: number }> {
  const config = await (prisma as any).rebateConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, rebatePercent: 40, freezeDays: 30 },
  });
  return { rebatePercent: config.rebatePercent, freezeDays: config.freezeDays };
}

export async function saveRebateConfig(prisma: PrismaClient, input: { rebatePercent?: number; freezeDays?: number }): Promise<{ rebatePercent: number; freezeDays: number }> {
  const current = await getRebateConfig(prisma);
  const rebatePercent = Math.max(0, Math.min(100, Math.floor(Number(input.rebatePercent ?? current.rebatePercent))));
  const freezeDays = Math.max(0, Math.floor(Number(input.freezeDays ?? current.freezeDays)));
  await (prisma as any).rebateConfig.update({ where: { id: 1 }, data: { rebatePercent, freezeDays } });
  return { rebatePercent, freezeDays };
}
