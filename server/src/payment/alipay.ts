// 支付宝电脑网站支付：RSA2 签名生成收银台跳转 URL + 异步通知验签。
// 官方文档：https://opendocs.alipay.com/open/270/105898
import crypto from 'node:crypto';
import type { AlipayConfig } from './config';

export interface AlipayPagePayInput {
  outTradeNo: string;
  amountCents: number;
  subject: string;
}

function beijingTimestamp(): string {
  // 支付宝要求 GMT+8 的 yyyy-MM-dd HH:mm:ss；不依赖服务器时区。
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

function signContent(params: Record<string, string>): string {
  // 支付宝规则：除 sign 外的请求参数都参与签名，包含 sign_type（官方文档“自行实现签名”）。
  // 之前把 sign_type 排除会让网关报 isv.invalid-signature，收银台 URL 和异步通知验签都会失败。
  return Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function rsaSign(content: string, privateKey: string): string {
  return crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64');
}

function rsaVerify(content: string, signature: string, publicKey: string): boolean {
  try {
    return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

export function buildAlipayPagePayUrl(config: AlipayConfig, input: AlipayPagePayInput): string {
  const params: Record<string, string> = {
    app_id: config.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTimestamp(),
    version: '1.0',
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: input.outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: (input.amountCents / 100).toFixed(2),
      subject: input.subject.slice(0, 128),
    }),
  };
  const sign = rsaSign(signContent(params), config.privateKey);
  const query = new URLSearchParams({ ...params, sign }).toString();
  return `${config.gateway}${config.gateway.includes('?') ? '&' : '?'}${query}`;
}

export interface AlipayNotifyResult {
  outTradeNo: string;
  amountCents: number;
  tradeStatus: string;
  appId: string;
}

/** 校验支付宝异步通知签名与关键字段；失败返回 null，调用方不得入账。 */
export function parseAlipayNotify(config: AlipayConfig, params: Record<string, string>): AlipayNotifyResult | null {
  const sign = params.sign || '';
  if (!sign) return null;
  const content = signContent(params);
  if (!rsaVerify(content, sign, config.alipayPublicKey)) return null;
  if (params.app_id !== config.appId) return null;
  const amount = Number(params.total_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    outTradeNo: String(params.out_trade_no || ''),
    amountCents: Math.round(amount * 100),
    tradeStatus: String(params.trade_status || ''),
    appId: String(params.app_id || ''),
  };
}

/** 测试/内部使用：按支付宝规则对参数签名（不参与运行时调用）。 */
export function signAlipayNotifyForTest(privateKey: string, params: Record<string, string>): string {
  return rsaSign(signContent(params), privateKey);
}
