// 支付网关配置（支付宝电脑网站支付 + 微信 Native）。
// 商户参数只从服务器环境变量读取，不落库、不返回给前端；未配置完整时对应渠道不可用。
import fs from 'node:fs';
import type { QuotaChannel } from '../quota/service';

export interface AlipayConfig {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  notifyUrl: string;
  returnUrl: string;
}

export interface WechatConfig {
  mchId: string;
  appId: string;
  apiV3Key: string;
  certSerialNo: string;
  privateKey: string;
  platformPublicKey: string;
  platformSerialNo: string;
  notifyUrl: string;
}

function env(name: string): string {
  return String(process.env[name] || '').trim();
}

function envEnabled(): boolean {
  return env('PAYMENT_ENABLED') !== '0';
}

function readTextSecret(name: string): string {
  const filePath = env(`${name}_FILE`);
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      return '';
    }
  }
  return env(name);
}

function readPemSecret(name: string, kind: 'private' | 'public'): string {
  const filePath = env(`${name}_FILE`);
  if (filePath) {
    try {
      return normalizePem(fs.readFileSync(filePath, 'utf8'), kind);
    } catch {
      return '';
    }
  }
  return normalizePem(env(name), kind);
}

function normalizePem(value: string, kind: 'private' | 'public'): string {
  const raw = String(value || '').trim().replace(/\\n/g, '\n');
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) return raw;
  const body = raw.replace(/\s+/g, '');
  const label = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join('\n') || body}\n-----END ${label}-----`;
}

export function getAlipayConfig(): AlipayConfig | null {
  if (!envEnabled()) return null;
  const appId = env('PAYMENT_ALIPAY_APP_ID');
  const privateKey = readPemSecret('PAYMENT_ALIPAY_PRIVATE_KEY', 'private');
  const alipayPublicKey = readPemSecret('PAYMENT_ALIPAY_PUBLIC_KEY', 'public');
  const notifyUrl = env('PAYMENT_ALIPAY_NOTIFY_URL');
  if (!appId || !privateKey || !alipayPublicKey || !notifyUrl) return null;
  return {
    appId,
    privateKey,
    alipayPublicKey,
    gateway: env('PAYMENT_ALIPAY_GATEWAY') || 'https://openapi.alipay.com/gateway.do',
    notifyUrl,
    returnUrl: env('PAYMENT_ALIPAY_RETURN_URL'),
  };
}

export function getWechatConfig(): WechatConfig | null {
  if (!envEnabled()) return null;
  const mchId = env('PAYMENT_WECHAT_MCH_ID');
  const appId = env('PAYMENT_WECHAT_APP_ID');
  const apiV3Key = readTextSecret('PAYMENT_WECHAT_API_V3_KEY');
  const certSerialNo = env('PAYMENT_WECHAT_CERT_SERIAL_NO');
  const privateKey = readPemSecret('PAYMENT_WECHAT_PRIVATE_KEY', 'private');
  const platformPublicKey = readPemSecret('PAYMENT_WECHAT_PLATFORM_PUBLIC_KEY', 'public');
  const notifyUrl = env('PAYMENT_WECHAT_NOTIFY_URL');
  if (!mchId || !appId || !apiV3Key || !certSerialNo || !privateKey || !platformPublicKey || !notifyUrl) return null;
  return {
    mchId,
    appId,
    apiV3Key,
    certSerialNo,
    privateKey,
    platformPublicKey,
    platformSerialNo: env('PAYMENT_WECHAT_PLATFORM_SERIAL_NO'),
    notifyUrl,
  };
}

export function isPaymentChannelConfigured(channel: QuotaChannel): boolean {
  return channel === 'alipay' ? Boolean(getAlipayConfig()) : Boolean(getWechatConfig());
}
