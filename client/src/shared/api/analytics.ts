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

// ===== 管理员报错管理 =====
export interface ErrorLogInfo {
  id: number;
  userId: number | null;
  username: string;
  projectId: number | null;
  level: 'error' | 'warn';
  source: string;
  summary: string;
  statusCode: number | null;
  resolved: boolean;
  createdAt: string;
}

export const ERROR_SOURCE_LABEL: Record<string, string> = {
  api: '接口异常',
  export: '导出',
  parse: '文件解析',
  task: '生成任务',
  ai: 'AI 调用',
};

export async function fetchErrorLogs(params: {
  level?: string;
  source?: string;
  resolved?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ total: number; unresolved: number; items: ErrorLogInfo[] }> {
  return http.get<{ total: number; unresolved: number; items: ErrorLogInfo[] }>('/analytics/errors', { params }).then((r) => r.data);
}

export async function resolveErrorLog(id: number): Promise<{ success: boolean; message: string }> {
  return http.post(`/analytics/errors/${id}/resolve`).then((r) => r.data);
}
