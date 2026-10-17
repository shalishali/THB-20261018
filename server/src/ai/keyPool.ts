// 多 Key 池：同一供应商可配置多个 API Key（profile.api_keys 数组 + 单 key 字段去重合并），
// 按轮询（round-robin）逐请求取用。配合全局并发队列扩容后，吞吐随 key 数量线性提升
//（每个 key 独立账号限额）。轮询计数按 base_url+model 维度，进程重启归零（无状态即可）。

const counters = new Map<string, number>();

// 坏 key 熔断：key 连续失败进入冷却期，轮询时优先跳过；冷却到期自动恢复参与。
// 全部 key 都在冷却时不做排除（保可用性，失败总比无服务好）。
const failures = new Map<string, { count: number; lastAt: number }>();
const KEY_COOLDOWN_MS = 60_000;

export function reportKeyFailure(key: string): void {
  if (!key) return;
  const prev = failures.get(key) || { count: 0, lastAt: 0 };
  failures.set(key, { count: prev.count + 1, lastAt: Date.now() });
}

export function reportKeySuccess(key: string): void {
  if (key) failures.delete(key);
}

function isCooling(key: string, now: number): boolean {
  const record = failures.get(key);
  return Boolean(record && now - record.lastAt < KEY_COOLDOWN_MS);
}

/** 解析可用 key 池：api_keys 数组在前、单 key 兜底，去重去空。 */
export function resolveApiKeyPool(config: any): string[] {
  const keys: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) keys.push(value.trim());
  };
  if (Array.isArray(config?.api_keys)) config.api_keys.forEach(push);
  push(config?.api_key);
  return [...new Set(keys)];
}

/** 逐请求轮询取 key；优先跳过冷却中的坏 key；全部冷却时取最近失败最久的一个。 */
export function pickRotatedApiKey(config: any): string {
  const pool = resolveApiKeyPool(config);
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  const now = Date.now();
  const healthy = pool.filter((key) => !isCooling(key, now));
  const candidates = healthy.length > 0 ? healthy : pool;
  const identity = `${config?.base_url || ''}|${config?.model_name || ''}`;
  const next = (counters.get(identity) || 0) + 1;
  counters.set(identity, next);
  return candidates[(next - 1) % candidates.length];
}
