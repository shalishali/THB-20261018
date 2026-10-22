// 充值订单主动对账：支付宝异步通知是主链路；本模块用于通知丢失、用户付款后未回跳、
// 管理员误点“核验”等场景。只有支付宝查询接口明确返回成功且金额一致才入账，
// 不允许在没有网关凭证的情况下把 pending 直接改成 paid。
import type { PrismaClient } from '@prisma/client';
import { getAlipayConfig, type AlipayConfig } from './config';
import { queryAlipayTrade, type AlipayTradeQueryResult } from './alipay';
import { markQuotaOrderPaid, type MarkQuotaOrderPaidResult } from '../quota/service';

type QueryTrade = (config: AlipayConfig, outTradeNo: string) => Promise<AlipayTradeQueryResult>;
type MarkPaid = (prisma: PrismaClient, orderId: string) => Promise<MarkQuotaOrderPaidResult>;

export interface ReconcileQuotaOrderResult {
  ok: boolean;
  paid: boolean;
  message: string;
  alreadyPaid?: boolean;
  tradeStatus?: string;
  order?: { id: string; userId: number; outTradeNo: string; chars: number; amountCents: number };
}

/**
 * 核对单笔支付宝订单。deps 仅用于单测注入假查询，生产不传。
 * 注意：查询成功但交易未成功（WAIT_BUYER_PAY/TRADE_CLOSED）返回 ok=true、paid=false，
 * 让调用方区分“还没付”与“查询失败”；查询失败不改变订单状态。
 */
export async function reconcileQuotaOrder(
  prisma: PrismaClient,
  orderId: string,
  deps: { queryTrade?: QueryTrade; config?: AlipayConfig | null; markPaid?: MarkPaid } = {},
): Promise<ReconcileQuotaOrderResult> {
  const order = await (prisma as any).quotaOrder.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, paid: false, message: '订单不存在' };
  if (order.status === 'paid') {
    return { ok: true, paid: true, alreadyPaid: true, message: '订单已入账，无需重复核对' };
  }
  if (order.status !== 'pending') {
    return { ok: false, paid: false, message: '订单已关闭，不能再次入账' };
  }
  if (order.channel !== 'alipay') {
    return { ok: false, paid: false, message: '当前仅支持支付宝订单自动核对' };
  }

  const config = deps.config === undefined ? getAlipayConfig() : deps.config;
  if (!config) return { ok: false, paid: false, message: '支付宝支付尚未配置' };

  let trade: AlipayTradeQueryResult;
  try {
    trade = await (deps.queryTrade || queryAlipayTrade)(config, order.outTradeNo);
  } catch (error) {
    return { ok: false, paid: false, message: error instanceof Error ? error.message : '支付宝查询失败' };
  }
  if (!trade.ok) {
    return { ok: false, paid: false, message: trade.error || '支付宝查询失败' };
  }
  if (!trade.found) {
    // 查询成功但没有交易：用户还没扫码/已放弃，不是查询失败，保持 pending 并计入“待支付”。
    return { ok: true, paid: false, message: '支付宝未查询到该交易，订单保持待支付' };
  }
  if (trade.tradeStatus !== 'TRADE_SUCCESS' && trade.tradeStatus !== 'TRADE_FINISHED') {
    return {
      ok: true,
      paid: false,
      tradeStatus: trade.tradeStatus,
      message: `支付宝交易状态为 ${trade.tradeStatus || 'unknown'}，暂不入账`,
    };
  }
  if (Number(trade.amountCents) !== Number(order.amountCents)) {
    return { ok: false, paid: false, tradeStatus: trade.tradeStatus, message: '支付宝交易金额与订单不一致，拒绝入账' };
  }

  const marked = await (deps.markPaid || markQuotaOrderPaid)(prisma, order.id);
  if (!marked.ok) {
    return { ok: false, paid: false, tradeStatus: trade.tradeStatus, message: marked.message || '入账失败' };
  }
  return {
    ok: true,
    paid: true,
    alreadyPaid: Boolean(marked.order?.alreadyPaid),
    tradeStatus: trade.tradeStatus,
    message: marked.message,
    order: marked.order
      ? {
          id: marked.order.id,
          userId: marked.order.userId,
          outTradeNo: marked.order.outTradeNo,
          chars: marked.order.chars,
          amountCents: marked.order.amountCents,
        }
      : undefined,
  };
}

export interface ReconcilePendingSummary {
  checked: number;
  paid: number;
  pending: number;
  failed: number;
  items: Array<{ orderId: string; outTradeNo: string; ok: boolean; paid: boolean; message: string }>;
}

/**
 * 批量核对最近未支付支付宝订单（后台定时任务与管理端“立即同步”共用）。
 * 只扫最近 N 小时，避免对历史废弃订单无限请求支付宝。
 */
export async function reconcilePendingQuotaOrders(
  prisma: PrismaClient,
  options: { limit?: number; lookbackHours?: number; queryTrade?: QueryTrade; markPaid?: MarkPaid; config?: AlipayConfig | null } = {},
): Promise<ReconcilePendingSummary> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 100);
  const lookbackHours = Math.min(Math.max(Math.floor(options.lookbackHours ?? 24), 1), 24 * 30);
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const rows: any[] = await (prisma as any).quotaOrder.findMany({
    where: { status: 'pending', channel: 'alipay', createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, outTradeNo: true },
  });

  const summary: ReconcilePendingSummary = { checked: 0, paid: 0, pending: 0, failed: 0, items: [] };
  for (const row of rows) {
    summary.checked += 1;
    const result = await reconcileQuotaOrder(prisma, row.id, {
      queryTrade: options.queryTrade,
      markPaid: options.markPaid,
      config: options.config,
    });
    if (result.paid) summary.paid += 1;
    else if (result.ok) summary.pending += 1;
    else summary.failed += 1;
    summary.items.push({ orderId: row.id, outTradeNo: row.outTradeNo, ok: result.ok, paid: result.paid, message: result.message });
  }
  return summary;
}

/**
 * 后台定时对账（默认 10 分钟一次，先等 30 秒让服务完成启动）。
 * 单进程部署；返回停止函数供测试/优雅关闭使用。
 */
export function startQuotaOrderReconciler(
  prisma: PrismaClient,
  logger: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void } = console,
): () => void {
  let stopped = false;
  let running = false;
  const run = async (): Promise<void> => {
    if (stopped || running) return;
    if (process.env.PAYMENT_ENABLED === '0') return;
    if (!getAlipayConfig()) return;
    running = true;
    try {
      const summary = await reconcilePendingQuotaOrders(prisma);
      if (summary.checked > 0) {
        logger.info({ ...summary, items: undefined }, '[payment] 支付宝订单自动对账完成');
      }
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : error }, '[payment] 支付宝订单自动对账失败');
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void run(), 30_000);
  const timer = setInterval(() => void run(), 10 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
