// 支付编排：创建收银台 payload、处理异步通知并调用既有幂等入账逻辑。
// 注意：真正加额度仍复用 markQuotaOrderPaid（订单 pending→paid + 加额度 + 返利同事务），
// 支付层只负责“验签 + 金额/商户/订单校验”，不重复实现资金逻辑。
import type { PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';
import type { QuotaChannel } from '../quota/service';
import { markQuotaOrderPaid } from '../quota/service';
import { getAlipayConfig, getWechatConfig, isPaymentChannelConfigured } from './config';
import { buildAlipayPagePayUrl, parseAlipayNotify } from './alipay';
import { createWechatNativeOrder, parseWechatNotify, type WechatNotifyHeaders } from './wechat';

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface PaymentLaunch {
  channel: QuotaChannel;
  /** redirect：跳转支付宝收银台；qrcode：展示微信二维码 */
  type: 'redirect' | 'qrcode';
  payUrl: string;
  qrDataUrl?: string;
  codeUrl?: string;
}

function normalizeOutTradeNo(value: unknown): string {
  return String(value || '').trim();
}

export async function startPaymentForOrder(
  prisma: PrismaClient,
  userId: number,
  orderId: string,
): Promise<PaymentLaunch> {
  const order = await prisma.quotaOrder.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== userId) throw new PaymentError('订单不存在', 404);
  if (order.status !== 'pending') throw new PaymentError('订单已支付或已关闭，不能重复发起支付', 409);
  const channel = order.channel as QuotaChannel;
  if (!isPaymentChannelConfigured(channel)) throw new PaymentError('该支付渠道尚未配置，请联系管理员', 503);

  if (channel === 'alipay') {
    const config = getAlipayConfig();
    if (!config) throw new PaymentError('支付宝支付尚未配置', 503);
    const payUrl = buildAlipayPagePayUrl(config, {
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
      subject: `投好标充值 ${order.planKey}`,
    });
    await prisma.quotaOrder.update({ where: { id: order.id }, data: { payUrl } });
    return { channel, type: 'redirect', payUrl };
  }

  const config = getWechatConfig();
  if (!config) throw new PaymentError('微信支付尚未配置', 503);
  const { codeUrl } = await createWechatNativeOrder(config, {
    outTradeNo: order.outTradeNo,
    amountCents: order.amountCents,
    description: `投好标充值 ${order.planKey}`,
  });
  const qrDataUrl = await QRCode.toDataURL(codeUrl, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  await prisma.quotaOrder.update({ where: { id: order.id }, data: { payUrl: codeUrl } });
  return { channel, type: 'qrcode', payUrl: codeUrl, codeUrl, qrDataUrl };
}

async function findOrderForNotify(prisma: PrismaClient, outTradeNo: string, channel: QuotaChannel) {
  const normalized = normalizeOutTradeNo(outTradeNo);
  if (!normalized) throw new PaymentError('回调缺少商户订单号');
  const order = await prisma.quotaOrder.findUnique({ where: { outTradeNo: normalized } });
  if (!order) throw new PaymentError('回调订单不存在');
  if (order.channel !== channel) throw new PaymentError('回调渠道与订单渠道不一致');
  return order;
}

export async function processAlipayNotify(prisma: PrismaClient, params: Record<string, string>): Promise<void> {
  const config = getAlipayConfig();
  if (!config) throw new PaymentError('支付宝支付尚未配置', 503);
  const parsed = parseAlipayNotify(config, params);
  if (!parsed) throw new PaymentError('支付宝回调验签失败');
  if (parsed.tradeStatus !== 'TRADE_SUCCESS' && parsed.tradeStatus !== 'TRADE_FINISHED') {
    throw new PaymentError(`支付宝交易未成功：${parsed.tradeStatus || 'unknown'}`);
  }
  const order = await findOrderForNotify(prisma, parsed.outTradeNo, 'alipay');
  if (Number(order.amountCents) !== parsed.amountCents) throw new PaymentError('支付宝回调金额与订单不一致');
  const result = await markQuotaOrderPaid(prisma, order.id);
  if (!result.ok) throw new PaymentError(result.message || '支付宝订单入账失败');
}

export async function processWechatNotify(
  prisma: PrismaClient,
  headers: WechatNotifyHeaders,
  rawBody: string,
): Promise<void> {
  const config = getWechatConfig();
  if (!config) throw new PaymentError('微信支付尚未配置', 503);
  const transaction = parseWechatNotify(config, headers, rawBody);
  if (!transaction) throw new PaymentError('微信回调验签/解密失败');
  if (transaction.tradeState !== 'SUCCESS') throw new PaymentError(`微信交易未成功：${transaction.tradeState || 'unknown'}`);
  if (transaction.mchId !== config.mchId || transaction.appId !== config.appId) {
    throw new PaymentError('微信回调商户号/AppID 与配置不一致');
  }
  const order = await findOrderForNotify(prisma, transaction.outTradeNo, 'wechat');
  if (Number(order.amountCents) !== Number(transaction.amountCents)) throw new PaymentError('微信回调金额与订单不一致');
  const result = await markQuotaOrderPaid(prisma, order.id);
  if (!result.ok) throw new PaymentError(result.message || '微信订单入账失败');
}
