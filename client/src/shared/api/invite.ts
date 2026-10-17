import { http } from './http';

// API-14/15 / FE-16：邀请推广（一期仅落库展示，不做结算提现）。
// 邀请码注册归因见登录/注册页 ?invite= 参数（API-06/FE-14 已实现）。

export interface InviteCodeResult {
  inviteCode: string;
  inviteUrl: string;
}

export interface InvitePromotionInvitee {
  id: number;
  name: string; // 后端已脱敏（保留首字）
  phone: string; // 后端已脱敏（前 3 后 4）
  registeredAt: string;
  status: string;
  /** 下线字数额度余额 */
  quotaChars?: number;
  /** 下线累计已用字数 */
  quotaUsedChars?: number;
  /** 下线累计充值金额（分，仅已核验订单） */
  totalRechargeCents?: number;
}

export interface InvitePromotionSummary {
  inviteCode: string;
  inviteUrl: string;
  inviteeCount: number;
  pendingRebateAmount: string; // Decimal 字符串，保精度
  page: number;
  pageSize: number;
  total: number;
  items: InvitePromotionInvitee[];
}

export const inviteApi = {
  code: () => http.get<InviteCodeResult>('/invite/code').then((r) => r.data),
  promotion: (params: { page?: number; pageSize?: number } = {}) =>
    http.get<InvitePromotionSummary>('/invite/promotion', { params }).then((r) => r.data),
};
