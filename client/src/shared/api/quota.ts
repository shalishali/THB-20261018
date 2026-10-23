// 字数额度：余额/套餐查询、充值订单创建与列表、跨组件事件。
// 事件解耦：导出层（export.ts）在 402 时广播 quota:insufficient；顶栏/任意入口可广播
// quota:open-dialog；全局唯一 QuotaRechargeDialog 监听并弹出。额度数值本体走 /api/me 快照
// （user.quotaChars），扣费/充值后广播 quota:refresh 触发 refreshUser。
import { http } from './http';

export interface QuotaPlan {
  key: string;
  chars: number;
  amountCents: number;
  label: string;
}

export type QuotaChannel = 'alipay' | 'wechat';

export interface QuotaOrderInfo {
  id: string;
  outTradeNo: string;
  planKey: string;
  chars: number;
  amountCents: number;
  channel: string;
  status: 'pending' | 'paid' | 'closed';
  createdAt: string;
  paidAt?: string | null;
}

export interface QuotaInsufficientDetail {
  required: number;
  balance: number;
  plans?: QuotaPlan[];
}

export interface QuotaPaymentLaunch {
  channel: QuotaChannel;
  type: 'redirect' | 'qrcode';
  payUrl: string;
  qrDataUrl?: string;
  codeUrl?: string;
}

export const QUOTA_OPEN_DIALOG_EVENT = 'quota:open-dialog';
export const QUOTA_INSUFFICIENT_EVENT = 'quota:insufficient';
export const QUOTA_REFRESH_EVENT = 'quota:refresh';

export function openQuotaDialog(): void {
  window.dispatchEvent(new CustomEvent(QUOTA_OPEN_DIALOG_EVENT));
}

export function notifyQuotaRefresh(): void {
  window.dispatchEvent(new CustomEvent(QUOTA_REFRESH_EVENT));
}

export function notifyQuotaInsufficient(detail: QuotaInsufficientDetail): void {
  window.dispatchEvent(new CustomEvent(QUOTA_INSUFFICIENT_EVENT, { detail }));
}

export function formatQuotaChars(chars: number | undefined | null): string {
  const value = Number(chars);
  if (!Number.isFinite(value) || value < 0) return '0 字';
  if (value < 10000) return `${Math.round(value)} 字`;
  const wan = value / 10000;
  const text = wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
  return `${text} 万字`;
}

export function formatAmountCents(amountCents: number): string {
  return `¥${(amountCents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export interface PublicQuotaPricing {
  signupGrantChars: number;
  plans: QuotaPlan[];
}

/** 未登录可读的计价快照：登录页/邀请页展示套餐与注册赠送额度。 */
export async function fetchPublicQuotaPricing(): Promise<PublicQuotaPricing> {
  const response = await http.get('/quota/public-pricing');
  return response.data;
}

export async function fetchQuota(): Promise<{
  quotaChars: number;
  plans: QuotaPlan[];
  /** 服务端实际开放的支付渠道；老版本服务端不返回时按支付宝兜底 */
  paymentChannels?: QuotaChannel[];
}> {
  const response = await http.get('/quota');
  return response.data;
}

export async function createQuotaOrder(planKey: string, channel: string): Promise<{ order: QuotaOrderInfo; gatewayReady: boolean }> {
  const response = await http.post('/quota/orders', { planKey, channel });
  return response.data;
}

export async function startQuotaPayment(orderId: string): Promise<QuotaPaymentLaunch> {
  // 显式传空对象：Fastify 对无 Content-Type 的 POST 会返回 415。
  const response = await http.post(`/quota/orders/${orderId}/pay`, {});
  return response.data.payment as QuotaPaymentLaunch;
}

export async function listQuotaOrders(): Promise<{ orders: QuotaOrderInfo[] }> {
  const response = await http.get('/quota/orders');
  return response.data;
}

export interface AdminAuditLogInfo {
  id: string;
  action: string;
  detail?: Record<string, unknown> | null;
  adminUsername: string;
  createdAt: string;
}

// 管理员：调整用户字数额度（deltaChars 增减 或 setChars 设为；单位：字）
export async function adjustUserQuota(
  userId: number,
  payload: { deltaChars?: number; setChars?: number; remark?: string },
): Promise<{ success: boolean; before: number; after: number; delta: number }> {
  const response = await http.post(`/quota/users/${userId}/adjust`, payload);
  return response.data;
}

// 管理员：查看某用户的操作记录（额度调整/账号编辑/删除）
export async function fetchAdjustLogs(userId: number): Promise<{ logs: AdminAuditLogInfo[] }> {
  const response = await http.get('/quota/adjust-logs', { params: { userId } });
  return response.data;
}

// 管理员：返利比例与冻结周期配置（GET/PUT /quota/rebate-config）
export interface RebateConfig {
  rebatePercent: number;
  freezeDays: number;
}

export async function fetchRebateConfig(): Promise<RebateConfig> {
  const response = await http.get<RebateConfig>('/quota/rebate-config');
  return response.data;
}

export async function saveRebateConfig(payload: Partial<RebateConfig>): Promise<RebateConfig> {
  const response = await http.put<RebateConfig>('/quota/rebate-config', payload);
  return response.data;
}
