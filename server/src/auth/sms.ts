// 短信验证码：发送（阿里云 / mock）+ 生成、哈希、时效与重试常量。
//
// 为什么"哈希存库 + 限次 + 一次性"是必须的：
// 短信验证码是当前唯一的登录因子，一旦明文落库或可无限重试，等同把账号密码写在数据库里。
// 因此：库里只存 sha256(phone:purpose:code:secret)，5 分钟过期，最多 5 次尝试，用后置 usedAt。
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';

export type SmsPurpose = 'login' | 'reset';
export type SmsProvider = 'aliyun' | 'mock';

export const SMS_CODE_TTL_MS = 5 * 60 * 1000;
/** 同一手机号同一用途的最小重发间隔 */
export const SMS_RESEND_INTERVAL_MS = 60 * 1000;
/** 单个验证码允许的最大校验次数 */
export const SMS_MAX_ATTEMPTS = 5;
/** 同一手机号 24 小时内最多发送条数（防短信轰炸与费用攻击） */
export const SMS_DAILY_LIMIT_PER_PHONE = 10;

export function getSmsProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  return raw === 'aliyun' ? 'aliyun' : 'mock';
}

export function isSmsConfigured(): boolean {
  const provider = getSmsProvider();
  // 生产环境绝不允许 mock：否则用户永远收不到验证码，且没有任何报错（静默不可登录）。
  // 这里返回 false，路由会明确回 503「短信服务尚未配置」。
  if (provider === 'mock') return process.env.NODE_ENV !== 'production';
  return Boolean(
    process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim() &&
      process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim() &&
      process.env.ALIYUN_SMS_SIGN_NAME?.trim() &&
      process.env.ALIYUN_SMS_TEMPLATE_CODE?.trim(),
  );
}

export function generateSmsCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 验证码哈希：phone/purpose 参与，避免同码在不同场景间被复用。 */
export function hashSmsCode(phone: string, purpose: SmsPurpose, code: string): string {
  const secret = process.env.SMS_CODE_SECRET?.trim() || process.env.JWT_SECRET || 'yibiao-sms';
  return createHash('sha256').update(`${phone}:${purpose}:${code}:${secret}`).digest('hex');
}

// ---- 阿里云短信（RPC 签名，SendSms 2017-05-25） ----
// RFC3986：encodeURIComponent 之外还要编码 !'()*，并把 + 还原为 %20、%7E 还原为 ~。
function percentEncode(value: string): string {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\+/g, '%20')
    .replace(/%7E/g, '~');
}

function aliyunTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function sendViaAliyun(phone: string, code: string): Promise<void> {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID!.trim();
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET!.trim();
  const signName = process.env.ALIYUN_SMS_SIGN_NAME!.trim();
  const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE!.trim();
  const regionId = (process.env.ALIYUN_SMS_REGION_ID || 'cn-hangzhou').trim();
  // 模板变量名：阿里云控制台模板里写的 ${code}，变量名默认就是 code
  const paramKey = (process.env.ALIYUN_SMS_TEMPLATE_PARAM_KEY || 'code').trim();

  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    RegionId: regionId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: aliyunTimestamp(),
    Version: '2017-05-25',
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ [paramKey]: code }),
  };

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  const url = `https://dysmsapi.aliyuncs.com/?Signature=${percentEncode(signature)}&${canonicalQuery}`;

  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let payload: { Code?: string; Message?: string; RequestId?: string } = {};
  try {
    payload = JSON.parse(text);
  } catch {
    /* 非 JSON 响应按失败处理 */
  }
  if (!response.ok || payload.Code !== 'OK') {
    // 只回传阿里云错误码与消息，绝不打印 AccessKey/签名
    throw new Error(`Aliyun SMS failed: ${payload.Code || response.status} ${payload.Message || text.slice(0, 120)}`);
  }
}

export interface SmsSendResult {
  delivered: boolean;
  provider: SmsProvider;
  /** 仅开发环境（非 production）的 mock 模式回传，便于联调；生产永不下发 */
  devCode?: string;
}

/** 发送验证码。失败抛错，由路由转成 502（不暴露上游细节给客户端）。 */
export async function sendSmsCode(phone: string, code: string): Promise<SmsSendResult> {
  const provider = getSmsProvider();
  if (provider === 'mock') {
    console.log(`[sms:mock] ${phone} -> ${code}（SMS_PROVIDER=mock，未真实发送）`);
    const devCode = process.env.NODE_ENV === 'production' ? undefined : code;
    return { delivered: false, provider, devCode };
  }
  await sendViaAliyun(phone, code);
  return { delivered: true, provider };
}
