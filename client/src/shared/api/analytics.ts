// 站点分析（管理员数据看板 + 公开访问埋点）
import { http, publicHttp } from './http';

export interface AnalyticsOverview {
  range: { days: number };
  visits: number;
  uniqueVisitors: number;
  logins: number;
  registrations: number;
  activeUsers: number;
  totalUsers: number;
  inactiveUsers: number;
  exports: number;
  aiCalls: number;
  series: Array<{ date: string; visits: number; logins: number; registrations: number }>;
}

export interface AnalyticsActivityItem {
  id: number;
  userId: number;
  username: string;
  action: string;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  createdAt: string;
}

export interface InactiveUserInfo {
  id: number;
  username: string;
  displayName: string | null;
  phone: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  quotaChars: number;
  quotaUsedChars: number;
}

// 公开埋点：登录页（匿名）与 AppShell 挂载各打一次；30s 去重由调用方控制
export function sendVisitBeacon(path: string): void {
  void publicHttp.post('/analytics/visit', { path }).catch(() => undefined);
}

export async function fetchAnalyticsOverview(days: number): Promise<AnalyticsOverview> {
  return http.get<AnalyticsOverview>('/analytics/overview', { params: { days } }).then((r) => r.data);
}

export async function fetchActivityLogs(params: { userId?: number; action?: string; page?: number; pageSize?: number }): Promise<{ total: number; items: AnalyticsActivityItem[] }> {
  return http.get<{ total: number; items: AnalyticsActivityItem[] }>('/analytics/activity', { params }).then((r) => r.data);
}

export async function fetchInactiveUsers(days: number): Promise<{ users: InactiveUserInfo[] }> {
  return http.get<{ users: InactiveUserInfo[] }>('/analytics/inactive', { params: { days } }).then((r) => r.data);
}
