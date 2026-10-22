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

export interface AlipayTradeQueryResult {
  /** 网关请求是否成功（不代表交易存在/成功） */
  ok: boolean;
  /** 支付宝是否存在该 out_trade_no */
  found: boolean;
  tradeStatus?: string;
  amountCents?: number;
  tradeNo?: string;
  error?: string;
}

/**
 * 主动查询支付宝交易。用于回调丢失后的兜底核对：
 * 只有网关明确返回 TRADE_SUCCESS/TRADE_FINISHED 且金额一致，调用方才能入账。
 * 这里不依赖支付宝 SDK，按开放平台签名规则直接请求 gateway。
 */
export async function queryAlipayTrade(
  config: AlipayConfig,
  outTradeNo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AlipayTradeQueryResult> {
  const params: Record<string, string> = {
    app_id: config.appId,
    method: 'alipay.trade.query',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
  };
  const sign = rsaSign(signContent(params), config.privateKey);
  const url = `${config.gateway}${config.gateway.includes('?') ? '&' : '?'}${new URLSearchParams({ ...params, sign }).toString()}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, found: false, error: error instanceof Error ? error.message : '支付宝查询请求失败' };
  }
  if (!response.ok) {
    return { ok: false, found: false, error: `支付宝查询 HTTP ${response.status}` };
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    return { ok: false, found: false, error: '支付宝查询返回非 JSON' };
  }
  const body = data?.alipay_trade_query_response || data?.error_response;
  if (!body || typeof body !== 'object') {
    return { ok: false, found: false, error: '支付宝查询返回结构异常' };
  }

  if (body.code === '10000') {
    const amount = Number(body.total_amount);
    return {
      ok: true,
      found: true,
      tradeStatus: String(body.trade_status || ''),
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
      tradeNo: body.trade_no ? String(body.trade_no) : undefined,
    };
  }
  // 40004 + ACQ.TRADE_NOT_EXIST：订单尚未支付/不存在。属于正常查询结果，不是网关故障。
  if (body.code === '40004' && String(body.sub_code || '') === 'ACQ.TRADE_NOT_EXIST') {
    return { ok: true, found: false, error: '支付宝未查询到该交易' };
  }
  return {
    ok: false,
    found: false,
    error: [body.code, body.sub_code, body.msg].filter(Boolean).join(' '),
  };
}
