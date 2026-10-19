import { http } from './http';

// API-13 / FE-17：个人 AI 调用统计（一期仅展示，不做扣费）。

export interface AiUsageRecord {
  id: number;
  userId: number;
  username?: string;
  projectId: number | null;
  provider: string;
  model: string;
  bizType: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  inputChars: number;
  outputChars: number;
  createdAt: string;
}

export interface AiUsageBizBucket {
  calls: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageProjectBucket {
  projectId: number;
  projectCode?: string;
  projectName: string;
  /** 项目创建时间（ISO）；项目已删除时为空 */
  projectCreatedAt?: string;
  projectDeleted?: boolean;
  ownerId?: number | null;
  ownerName?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  textTokens: number;
  imageTokens: number;
  imageCalls?: number;
}

export interface AiUsageUserBucket {
  userId: number;
  username: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  inputChars: number;
  outputChars: number;
}

export interface AiUsageDayBucket {
  date: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageModelBucket {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageProviderBucket {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageSummary {
  days: number;
  page: number;
  pageSize: number;
  /** 管理员=all（全站），普通用户=self（仅本人） */
  scope?: 'all' | 'self';
  /** 统计切日时区（默认 Asia/Shanghai） */
  timeZone?: string;
  filters?: { userId: number | null; keyword: string };
  filterOptions?: { users: Array<{ userId: number; username: string }> };
  totalRows: number;
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    inputChars: number;
    outputChars: number;
  };
  byBizType: Record<string, AiUsageBizBucket>;
  byProject?: AiUsageProjectBucket[];
  byUser?: AiUsageUserBucket[];
  byDay?: AiUsageDayBucket[];
  byModel?: AiUsageModelBucket[];
  byProvider?: AiUsageProviderBucket[];
  items: AiUsageRecord[];
}

export const aiUsageStatsApi = {
  list(params: { days?: number; page?: number; pageSize?: number; userId?: number; keyword?: string } = {}) {
    return http.get<AiUsageSummary>('/stats/ai-usage', { params }).then((r) => r.data);
  },
};
