import { http } from './http';

// API-13 / FE-17：个人 AI 调用统计（一期仅展示，不做扣费）。

export interface AiUsageRecord {
  id: number;
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
  projectName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  textTokens: number;
  imageTokens: number;
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
  byDay?: AiUsageDayBucket[];
  byModel?: AiUsageModelBucket[];
  byProvider?: AiUsageProviderBucket[];
  items: AiUsageRecord[];
}

export const aiUsageStatsApi = {
  list(params: { days?: number; page?: number; pageSize?: number } = {}) {
    return http.get<AiUsageSummary>('/stats/ai-usage', { params }).then((r) => r.data);
  },
};
