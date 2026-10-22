// 字数额度服务：注册赠送、导出扣减、充值订单。
// 计费口径与正文统计一致：非空白字符数（contentStats.totalWords 同源）。
// 支付网关（支付宝/微信）需要商户资质后接入：一期先落订单与状态流转，
// 管理员可经 POST /quota/orders/:id/paid 人工核验充值（线下转账/收款码场景）。
import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { isPaymentChannelConfigured } from '../payment/config';

export interface QuotaPlan {
  key: string;
  chars: number;
  amountCents: number; // 分，避免浮点
  label: string;
}

// 默认套餐：仅作为 QuotaConfig 首次初始化的种子数据；此后以数据库配置为准（管理员可动态调整）。
export const QUOTA_PLANS: QuotaPlan[] = [
  { key: 'plan-10w', chars: 100000, amountCents: 390, label: '10 万字' },
  { key: 'plan-20w', chars: 200000, amountCents: 500, label: '20 万字' },
  { key: 'plan-50w', chars: 500000, amountCents: 1000, label: '50 万字' },
  { key: 'plan-110w', chars: 1100000, amountCents: 2000, label: '110 万字' },
];

export const QUOTA_CHANNELS = ['alipay', 'wechat'] as const;
export type QuotaChannel = (typeof QUOTA_CHANNELS)[number];

export interface QuotaPricing {
  signupGrantChars: number;
  plans: QuotaPlan[];
}

const QUOTA_CONFIG_ID = 1;

function normalizePlans(value: unknown): QuotaPlan[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const plans: QuotaPlan[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const key = String(item.key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const label = String(item.label || '').trim().slice(0, 30);
    const chars = Math.floor(Number(item.chars));
    const amountCents = Math.floor(Number(item.amountCents));
    if (!key || seen.has(key) || !label) continue;
    // quotaChars 是 Prisma Int（Postgres int4，上限 2147483647）。套餐上限收到 10 亿，
    // 给多次核销/调整留出叠加空间，避免 increment 溢出导致订单永久 pending。
    if (!Number.isFinite(chars) || chars < 1000 || chars > 1_000_000_000) continue;
    if (!Number.isFinite(amountCents) || amountCents < 0 || amountCents > 2_000_000_000) continue;
    seen.add(key);
    plans.push({ key, chars, amountCents, label });
  }
  return plans;
}

/** 读取计费配置（充值套餐 + 注册赠送额度）；首次访问时以默认套餐初始化。 */
export async function getQuotaPricing(prisma: PrismaClient): Promise<QuotaPricing> {
  let row = await (prisma as any).quotaConfig.findUnique({ where: { id: QUOTA_CONFIG_ID } });
  if (!row) {
    row = await (prisma as any).quotaConfig
      .create({ data: { id: QUOTA_CONFIG_ID, signupGrantChars: 100000, plans: QUOTA_PLANS } })
      .catch(() => (prisma as any).quotaConfig.findUnique({ where: { id: QUOTA_CONFIG_ID } }));
  }
  if (!row) return { signupGrantChars: 100000, plans: QUOTA_PLANS };
  const plans = normalizePlans(row.plans);
  return {
    signupGrantChars: Math.max(0, Math.floor(Number(row.signupGrantChars) || 0)),
    plans: plans.length > 0 ? plans : QUOTA_PLANS,
  };
}

/** 保存计费配置（管理员）：套餐与注册赠送额度。校验失败抛错（路由转 400）。 */
export async function saveQuotaPricing(
  prisma: PrismaClient,
  input: { signupGrantChars?: unknown; plans?: unknown },
): Promise<QuotaPricing> {
  const current = await getQuotaPricing(prisma);
  let signupGrantChars = current.signupGrantChars;
  if (input.signupGrantChars !== undefined) {
    const value = Math.floor(Number(input.signupGrantChars));
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      throw new Error('注册赠送字数必须是 0~10 亿的整数');
    }
    signupGrantChars = value;
  }
  let plans = current.plans;
  if (input.plans !== undefined) {
    if (!Array.isArray(input.plans) || input.plans.length === 0 || input.plans.length > 8) {
      throw new Error('套餐数量必须是 1~8 个');
    }
    plans = normalizePlans(input.plans);
    if (plans.length === 0) throw new Error('套餐数据无效：需包含名称、字数（≥1000）与价格');
  }
  await (prisma as any).quotaConfig.upsert({
    where: { id: QUOTA_CONFIG_ID },
    update: { signupGrantChars, plans: plans as any },
    create: { id: QUOTA_CONFIG_ID, signupGrantChars, plans: plans as any },
  });
  return { signupGrantChars, plans };
}

/** 按 key 查套餐（动态配置版）。 */
export async function findQuotaPlan(prisma: PrismaClient, planKey: unknown): Promise<QuotaPlan | null> {
  if (typeof planKey !== 'string') return null;
  const pricing = await getQuotaPricing(prisma);
  return pricing.plans.find((plan) => plan.key === planKey) || null;
}

/** 新账号注册赠送字数（注册/登录即注册/管理员建号统一走这里）。
 *  防御性回退：注册是主流程，配置读取失败（表缺失/瞬断）时回落 10 万字默认值，绝不让注册 500。 */
export async function getSignupGrantChars(prisma: PrismaClient): Promise<number> {
  try {
    return (await getQuotaPricing(prisma)).signupGrantChars;
  } catch (error) {
    console.warn('[quota] 注册赠送额度读取失败，回落默认 100000:', error instanceof Error ? error.message : error);
    return 100000;
  }
}

export function isQuotaChannel(channel: unknown): channel is QuotaChannel {
  return typeof channel === 'string' && (QUOTA_CHANNELS as readonly string[]).includes(channel);
}

// 对外实际开放的支付渠道：默认只开放支付宝。微信 Native 需要已完成认证并绑定商户号的
// AppID，未完成前即使环境变量里存在微信商户参数也不能让用户下单（会报 APPID_MCHID_NOT_MATCH）。
// 运维可通过 PAYMENT_CHANNELS=alipay,wechat 显式开启多个渠道；未知值会被忽略。
const DEFAULT_ENABLED_CHANNELS: QuotaChannel[] = ['alipay'];

export function getEnabledQuotaChannels(): QuotaChannel[] {
  const raw = String(process.env.PAYMENT_CHANNELS || '').trim();
  if (!raw) return [...DEFAULT_ENABLED_CHANNELS];
  const channels = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item, index, list): item is QuotaChannel => isQuotaChannel(item) && list.indexOf(item) === index);
  return channels.length ? channels : [...DEFAULT_ENABLED_CHANNELS];
}

export function isQuotaChannelEnabled(channel: unknown): channel is QuotaChannel {
  return isQuotaChannel(channel) && getEnabledQuotaChannels().includes(channel);
}

export async function getQuotaChars(prisma: PrismaClient, userId: number): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { quotaChars: true } });
  return user?.quotaChars ?? 0;
}

// 统计导出大纲的正文字数：口径全站唯一（utils/textCount），显示/预算校验/扣费同一实现。
export { countOutlineContentChars } from '../utils/textCount';

// 导出内容指纹：与 countOutlineContentChars 同一棵树递归收集原始 content（含全部子节点）。
// 指纹只取内容，不再把字数额进哈希：字数口径调整（如围栏代码块计入计费）不应让同一份内容
// 变成"新内容"而重复扣费（2026-10-20 修复）。
export function buildExportContentFingerprint(items: unknown): string {
  const contents: string[] = [];
  const walk = (nodes: any[]): void => {
    for (const node of nodes || []) {
      if (typeof node?.content === 'string') contents.push(node.content);
      if (node?.children?.length) walk(node.children);
    }
  };
  walk(Array.isArray(items) ? (items as any[]) : []);
  return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

// 历史指纹兼容：旧实现是 sha256(`${chars}:${JSON.stringify(contents)}`)，且字数口径调整过两次
// （围栏代码块是否计入）。这里同时生成「当前口径字数」和「旧口径字数（剔除围栏）」两个候选，
// 去重查询时任一命中都视为已计费，避免升级后同一内容被重复扣费。
function countLegacyChars(content: string): number {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)．、]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\|/g, '')
    .replace(/[-=]{3,}/g, '')
    .replace(/\s/g, '')
    .length;
}

export function buildLegacyExportFingerprints(items: unknown, chars: number): string[] {
  const contents: string[] = [];
  const walk = (nodes: any[]): void => {
    for (const node of nodes || []) {
      if (typeof node?.content === 'string') contents.push(node.content);
      if (node?.children?.length) walk(node.children);
    }
  };
  walk(Array.isArray(items) ? (items as any[]) : []);
  const json = JSON.stringify(contents);
  const legacyChars = contents.reduce((sum, content) => sum + countLegacyChars(content), 0);
  const candidates = new Set<string>([
    createHash('sha256').update(`${chars}:${json}`).digest('hex'),
    createHash('sha256').update(`${legacyChars}:${json}`).digest('hex'),
  ]);
  return [...candidates];
}

/** 该用户是否已为这份内容计过费（任一历史/当前指纹命中）。 */
export async function isExportAlreadyBilled(prisma: PrismaClient, userId: number, fingerprints: string[]): Promise<boolean> {
  const row = await (prisma as any).quotaConsumeLog.findFirst({
    where: { userId, fingerprint: { in: fingerprints } },
    select: { id: true },
  });
  return Boolean(row);
}

// DB-17：导出消费流水查询（流水本身由 chargeExportOnce 在扣费事务内落库）
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
// 并发安全：不做过期快照的整值覆盖写（读-算-写会把并发导出的扣减吞掉）——
// "增减"走条件原子 increment/decrement；"设为"走 CAS（compare-and-set）重试。
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

  let before = target.quotaChars;
  let after = before;

  if (typeof input.setChars === 'number' && Number.isFinite(input.setChars)) {
    // 设为：CAS 循环，只在余额仍等于读取值时写入，防止覆盖并发扣减/入账。
    // 同时钳到 int4 安全上限，避免管理员误填 20 亿导致写入溢出。
    after = Math.min(2_000_000_000, Math.max(0, Math.floor(input.setChars)));
    let current = before;
    let committed = false;
    for (let attempt = 0; attempt < 5 && !committed; attempt += 1) {
      if (current === after) return { ok: false, message: '调整前后余额相同，无需调整' };
      const updated = await prisma.user.updateMany({
        where: { id: targetUserId, quotaChars: current },
        data: { quotaChars: after },
      });
      if (updated.count > 0) {
        committed = true;
        break;
      }
      const fresh = await prisma.user.findUnique({ where: { id: targetUserId }, select: { quotaChars: true } });
      current = fresh?.quotaChars ?? 0;
      before = current;
      after = Math.max(0, Math.floor(input.setChars));
    }
    if (!committed) {
      return { ok: false, message: '余额变动过于频繁，请稍后重试' };
    }
  } else if (typeof input.deltaChars === 'number' && Number.isFinite(input.deltaChars) && input.deltaChars !== 0) {
    // 增减：原子增量。负向调整可能把余额压到 0 以下，用条件更新兜底：
    // 余额足够 → 直接增减；不足（count=0）→ 说明当前余额 < |delta|，置 0（与"扣到 0 为止"语义一致）。
    const delta = Math.floor(input.deltaChars);
    before = target.quotaChars;
    if (delta > 0) {
      await prisma.user.update({ where: { id: targetUserId }, data: { quotaChars: { increment: delta } } });
    } else {
      const magnitude = -delta;
      const decremented = await prisma.user.updateMany({
        where: { id: targetUserId, quotaChars: { gte: magnitude } },
        data: { quotaChars: { decrement: magnitude } },
      });
      if (decremented.count === 0) {
        // 余额不足以扣 |delta|：按"扣到 0 为止"语义兜底置 0。
        await prisma.user.updateMany({ where: { id: targetUserId }, data: { quotaChars: 0 } });
      }
    }
    // 以落库后的实际余额为准（并发导出可能在读取与写入之间扣减过）。
    // 注意：此时增减已落库，即使实际净变化为 0（被并发扣减恰好抵消），也必须走外层审计落一条
    // delta=0 的记录——绝不能在这里按"无变化"早退，否则调整实际生效却无留痕、管理员还看到失败。
    const freshAfter = await prisma.user.findUnique({ where: { id: targetUserId }, select: { quotaChars: true } });
    after = freshAfter?.quotaChars ?? before;
  } else {
    return { ok: false, message: '请填写要增减的字数或目标余额' };
  }

  const delta = after - before;
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

// 支付网关是否已配置（支付宝电脑网站支付/微信 Native 的商户凭证走 env；未配置或 PAYMENT_ENABLED=0
// 时订单停留在 pending，由管理员人工核验）。只看当前开放渠道，避免“微信参数残留”把支付宝/手工核验状态带偏。
export function isPaymentGatewayConfigured(): boolean {
  return getEnabledQuotaChannels().some((channel) => isPaymentChannelConfigured(channel));
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

export interface MarkQuotaOrderPaidResult {
  ok: boolean;
  message: string;
  /** 审计用订单信息（ok=true 时必有） */
  order?: { id: string; userId: number; outTradeNo: string; chars: number; amountCents: number; alreadyPaid: boolean };
}

// 管理员人工核验：pending → paid 并入账（幂等：已 paid 直接返回，不重复加额度）。
// 入账成功后按返利配置给邀请人生成"冻结"返利流水（API-25/26：比例可配 + 冻结周期防套利）。
// 「改订单状态」「加额度」「返利流水」三者同事务：任何一步失败整体回滚，管理员重试即可——
// 此前返利在事务外 best-effort，事务提交后、返利写入前若进程崩溃/DB 抖动，该笔返利会静默丢失
// （再次核验又在 paid 早退处跳过，永不补建）。已 paid 的早退分支仍会补跑一次返利结算
// （自带幂等），用于修复历史遗漏。
export async function markQuotaOrderPaid(prisma: PrismaClient, orderId: string): Promise<MarkQuotaOrderPaidResult> {
  const order = await prisma.quotaOrder.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, message: '订单不存在' };
  const orderInfo = { id: order.id, userId: order.userId, outTradeNo: order.outTradeNo, chars: order.chars, amountCents: order.amountCents };

  if (order.status === 'paid') {
    // 已核验过：不再重复加额度，但补跑返利结算（幂等），修复历史"入账成功、返利丢失"的订单。
    try {
      await prisma.$transaction(async (tx) => {
        await settleRebateForPaidOrder(tx as unknown as PrismaClient, order.userId, order.outTradeNo, order.amountCents);
      });
    } catch (error) {
      console.error('[rebate] 补建历史返利流水失败:', error instanceof Error ? error.message : error);
    }
    return { ok: true, message: '订单已核验过，额度未重复入账', order: { ...orderInfo, alreadyPaid: true } };
  }

  const result = await prisma.$transaction(async (tx) => {
    // 溢出预检必须放在状态翻转之前：quotaChars 是 int4，入账后超过 2^31-1 会让 update 抛错，
    // 而订单状态已经翻成 paid 会留下无法核销的脏数据。这里先读余额再决定。
    const target = await tx.user.findUnique({ where: { id: order.userId }, select: { quotaChars: true } });
    const nextBalance = Number(target?.quotaChars || 0) + Number(order.chars || 0);
    if (nextBalance > 2_000_000_000) {
      return { ok: false, message: '入账后额度将超出系统上限（20 亿），请调整套餐字数或分次核销' };
    }
    // 条件更新做并发闸门：两个管理员同时点核验，只有一个能把 pending 翻成 paid。
    const updated = await tx.quotaOrder.updateMany({
      where: { id: orderId, status: 'pending' },
      data: { status: 'paid', paidAt: new Date() },
    });
    if (updated.count === 0) return { ok: false, message: '订单状态已变化，请刷新后重试' };
    await tx.user.update({ where: { id: order.userId }, data: { quotaChars: { increment: order.chars } } });
    await settleRebateForPaidOrder(tx as unknown as PrismaClient, order.userId, order.outTradeNo, order.amountCents);
    return { ok: true, message: `已核验并入账 ${order.chars} 字额度` };
  });
  if (!result.ok) return result;
  return { ...result, order: { ...orderInfo, alreadyPaid: false } };
}

// API-25/26：被邀请人付费订单核验后，按全局比例给邀请人生成"冻结"返利流水；
// 冻结到期（freezeUntil）后由二期结算任务/人工置为 settled；退款扣回（refundClawback）预留。
// 调用方必须在事务内调用：金额计算全程以"分"为整数（Math.floor 向下取整，平台有利），
// 避免浮点除法在 x.xx5 边界的舍入方向漂移。命中自邀启发式（注册 IP 相同）时跳过并告警。
async function settleRebateForPaidOrder(prisma: PrismaClient, payerUserId: number, outTradeNo: string, amountCents: number): Promise<void> {
  const config = await (prisma as any).rebateConfig.findUnique({ where: { id: 1 } });
  const percent = Math.max(0, Math.min(100, Number(config?.rebatePercent ?? 30)));
  const freezeDays = Math.max(0, Number(config?.freezeDays ?? 30));
  if (percent <= 0 || amountCents <= 0) return;
  const relation = await (prisma as any).inviteRelation.findUnique({
    where: { inviteeId: payerUserId },
    select: { inviterId: true },
  });
  if (!relation?.inviterId || relation.inviterId === payerUserId) return;
  const exists = await (prisma as any).rebateFlow.findFirst({ where: { sourceOrderId: outTradeNo }, select: { id: true } });
  if (exists) return; // 幂等：同一订单只生成一次返利

  // 反作弊启发式（DB-22 一期）：被邀请人与邀请人注册 IP 相同 → 高概率自邀小号，跳过返利并告警。
  // 完整反作弊（设备指纹、活跃 IP 比对）按 product_mvp 留待二期支付上线前落地。
  const [inviter, invitee] = await Promise.all([
    (prisma as any).user.findUnique({ where: { id: relation.inviterId }, select: { registerIp: true } }),
    (prisma as any).user.findUnique({ where: { id: payerUserId }, select: { registerIp: true } }),
  ]);
  if (inviter?.registerIp && invitee?.registerIp && inviter.registerIp === invitee.registerIp) {
    console.warn(`[rebate] 疑似自邀（双方注册 IP 相同：${inviter.registerIp}），跳过订单 ${outTradeNo} 的返利`);
    return;
  }

  // 整数分运算：rebateCents = floor(实付分 × 比例% / 100)，再转元字符串（两位小数，无浮点误差）。
  const rebateCents = Math.floor((amountCents * percent) / 100);
  const amountYuan = (rebateCents / 100).toFixed(2);
  const freezeUntil = freezeDays > 0 ? new Date(Date.now() + freezeDays * 24 * 60 * 60 * 1000) : null;
  await (prisma as any).rebateFlow.create({
    data: {
      inviterId: relation.inviterId,
      inviteeId: payerUserId,
      sourceType: 'order',
      sourceOrderId: outTradeNo,
      amount: amountYuan,
      settleStatus: 'pending',
      freezeUntil,
    },
  });
}

// DB-19：返利配置读取（无记录时自动建默认 30% / 30 天）
export async function getRebateConfig(prisma: PrismaClient): Promise<{ rebatePercent: number; freezeDays: number }> {
  const config = await (prisma as any).rebateConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, rebatePercent: 30, freezeDays: 30 },
  });
  return { rebatePercent: config.rebatePercent, freezeDays: config.freezeDays };
}

export async function saveRebateConfig(prisma: PrismaClient, input: { rebatePercent?: number; freezeDays?: number }): Promise<{ rebatePercent: number; freezeDays: number }> {
  const current = await getRebateConfig(prisma);
  const rebatePercent = Math.max(0, Math.min(100, Math.floor(Number(input.rebatePercent ?? current.rebatePercent))));
  // 冻结周期上限 3650 天（10 年）：防误配出"10 万天"这类荒谬值（无资金风险，仅配置合理性）。
  const freezeDays = Math.max(0, Math.min(3650, Math.floor(Number(input.freezeDays ?? current.freezeDays))));
  await (prisma as any).rebateConfig.update({ where: { id: 1 }, data: { rebatePercent, freezeDays } });
  return { rebatePercent, freezeDays };
}
