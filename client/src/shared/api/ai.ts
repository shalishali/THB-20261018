// AI 命名空间的 Web 实现：window.yibiao.ai.* 与 window.yibiao.config.listModels 的底层。
// 服务端持真实 key 代理上游；浏览器只通过这些端点拿聚合结果。
import { http } from './http';

export interface AiChatRequest {
  messages: unknown[];
  temperature?: number;
  response_format?: unknown;
  timeout_ms?: number;
  timeout_message?: string;
  logTitle?: string;
  [key: string]: unknown;
}
export interface AiJsonRequest extends AiChatRequest {
  max_retries?: number;
  normalizer?: (parsed: unknown) => unknown;
  validator?: (normalized: unknown) => void;
  progressLabel?: string;
  failureMessage?: string;
  progressCallback?: (message: string) => void;
  repairMessagesBuilder?: (ctx: unknown) => unknown;
  [key: string]: unknown;
}
export interface ListModelsResult {
  success: boolean;
  message: string;
  models: string[];
}
export interface TestImageModelResult {
  success: boolean;
  message: string;
  image_url?: string;
  image_data?: string;
  mime_type?: string;
}

// axios 错误 → 带 server message 的 Error（与桌面 IPC 抛 Error.message 语义一致）。
function normalizeError(err: unknown): Error {
  const anyErr = err as any;
  if (anyErr?.response?.data) {
    const d = anyErr.response.data;
    const e: any = new Error(d.message || d.error || 'AI 请求失败');
    if (anyErr.response.status) e.status = anyErr.response.status;
    return e;
  }
  return err instanceof Error ? err : new Error(String(err || 'AI 请求失败'));
}

export const aiApi = {
  async chat(request: AiChatRequest): Promise<string> {
    try {
      const { data } = await http.post<{ content?: string; message?: string }>('/ai/chat', request);
      return data.content ?? '';
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async requestJson<TResult = unknown>(request: AiJsonRequest): Promise<TResult> {
    try {
      const { data } = await http.post<{ result?: TResult; message?: string }>('/ai/request-json', request);
      return data.result as TResult;
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async testKeyPool(payload: { base_url?: string; model_name?: string; api_keys: string[] }): Promise<{
    success: boolean;
    message?: string;
    results: Array<{
      key_masked: string;
      base_url: string;
      model_name: string;
      ok: boolean;
      latency_ms: number;
      models_count: number;
      model_found: boolean | null;
      message: string;
    }>;
  }> {
    try {
      const { data } = await http.post<{ success: boolean; message?: string; results: Array<Record<string, unknown>> }>('/ai/test-key-pool', payload);
      return {
        success: data.success,
        message: data.message,
        results: (data.results || []) as never,
      };
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async listModels(config?: unknown): Promise<ListModelsResult> {
    try {
      const { data } = await http.post<ListModelsResult>('/ai/list-models', config ?? {});
      return data;
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async testImageModel(config: unknown): Promise<TestImageModelResult> {
    try {
      const { data } = await http.post<TestImageModelResult>('/ai/test-image-model', config);
      return data;
    } catch (err) {
      throw normalizeError(err);
    }
  },
};
