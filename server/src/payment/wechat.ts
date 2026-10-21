// 微信支付 APIv3 Native 下单 + 回调验签/解密。
// 官方文档：https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_4_1.shtml
import crypto from 'node:crypto';
import type { WechatConfig } from './config';

const WECHAT_NATIVE_PATH = '/v3/pay/transactions/native';

export interface WechatNativeInput {
  outTradeNo: string;
  amountCents: number;
  description: string;
}

function nonce(): string {
  return crypto.randomBytes(16).toString('hex');
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

export function buildWechatAuthorization(
  config: WechatConfig,
  method: string,
  urlPath: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  nonceStr = nonce(),
): string {
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signature = rsaSign(message, config.privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.certSerialNo}"`;
}

/** 调微信 Native 下单，返回 code_url（前端生成二维码）。不记录密钥或购物内容。 */
export async function createWechatNativeOrder(config: WechatConfig, input: WechatNativeInput): Promise<{ codeUrl: string }> {
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: input.description.slice(0, 127),
    out_trade_no: input.outTradeNo,
    notify_url: config.notifyUrl,
    amount: { total: Number(input.amountCents), currency: 'CNY' },
  });
  const response = await fetch(`https://api.mch.weixin.qq.com${WECHAT_NATIVE_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: buildWechatAuthorization(config, 'POST', WECHAT_NATIVE_PATH, body),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'thb-payment/1.0',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
      detail = [parsed.code, parsed.message].filter((value) => typeof value === 'string' && value).join(' ');
    } catch {
      /* 非 JSON 错误体不返回给客户端 */
    }
    throw new Error(`微信 Native 下单失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
  }
  let parsed: { code_url?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('微信 Native 下单返回格式异常');
  }
  const codeUrl = typeof parsed.code_url === 'string' ? parsed.code_url : '';
  if (!codeUrl) throw new Error('微信 Native 下单未返回 code_url');
  return { codeUrl };
}

export interface WechatNotifyHeaders {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  serial?: string;
}

export interface WechatTransaction {
  outTradeNo: string;
  amountCents: number;
  mchId: string;
  appId: string;
  tradeState: string;
}

/** 验签 + AES-256-GCM 解密微信支付回调；任何失败返回 null。 */
export function parseWechatNotify(
  config: WechatConfig,
  headers: WechatNotifyHeaders,
  rawBody: string,
): WechatTransaction | null {
  const timestamp = String(headers.timestamp || '');
  const nonceStr = String(headers.nonce || '');
  const signature = String(headers.signature || '');
  const serial = String(headers.serial || '');
  if (!timestamp || !nonceStr || !signature) return null;
  if (config.platformSerialNo && serial !== config.platformSerialNo) return null;
  const message = `${timestamp}\n${nonceStr}\n${rawBody}\n`;
  if (!rsaVerify(message, signature, config.platformPublicKey)) return null;

  let payload: { event_type?: unknown; resource?: { algorithm?: unknown; ciphertext?: unknown; nonce?: unknown; associated_data?: unknown } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (payload.event_type !== 'TRANSACTION.SUCCESS') return null;
  const resource = payload.resource;
  if (!resource || resource.algorithm !== 'AEAD_AES_256_GCM' || typeof resource.ciphertext !== 'string' || typeof resource.nonce !== 'string') {
    return null;
  }
  try {
    const key = Buffer.from(config.apiV3Key, 'utf8');
    if (key.length !== 32) return null;
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
    decipher.setAuthTag(authTag);
    if (typeof resource.associated_data === 'string' && resource.associated_data) {
      decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    }
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const transaction = JSON.parse(plain) as {
      out_trade_no?: unknown;
      amount?: { total?: unknown };
      mchid?: unknown;
      appid?: unknown;
      trade_state?: unknown;
    };
    return {
      outTradeNo: String(transaction.out_trade_no || ''),
      amountCents: Number(transaction.amount?.total),
      mchId: String(transaction.mchid || ''),
      appId: String(transaction.appid || ''),
      tradeState: String(transaction.trade_state || ''),
    };
  } catch {
    return null;
  }
}

/** 测试/内部使用：按微信规则对回调报文签名（不参与运行时调用）。 */
export function signWechatNotifyForTest(platformPrivateKey: string, timestamp: string, nonceStr: string, rawBody: string): string {
  return rsaSign(`${timestamp}\n${nonceStr}\n${rawBody}\n`, platformPrivateKey);
}

export { WECHAT_NATIVE_PATH };
