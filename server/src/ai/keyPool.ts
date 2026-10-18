// 多平台多 Key 池：同一配置下可同时挂多个平台的 API Key。
// 条目格式（存储为字符串，竖线分隔，兼容全角｜）：
//   `Key`                      —— 同平台多账号（沿用主配置的 Base URL / 模型名）
//   `Key|Base URL`             —— 跨平台：使用该平台的端点，模型名沿用主配置
//   `Key|Base URL|模型名`       —— 跨平台且指定该平台模型（推荐：各平台模型名不同）
// 逐请求轮询（round-robin）取用；坏 key（401/402/403/429）进入 60s 冷却，轮询跳过，
// 全部冷却时保可用不排除。配合全局并发队列扩容后，吞吐随条目数量提升。

export interface PooledKey {
  key: string;
  /** 已解析的请求端点：条目自带优先，否则回落主配置 */
  base_url: string;
  /** 已解析的模型名：条目自带优先，否则回落主配置 */
  model_name: string;
}

const counters = new Map<string, number>();

// 坏 key 熔断：key 失败进入冷却期（连续失败按指数递增：60s → 120s → 240s…上限 10 分钟；
// 显式传入 cooldownMs（如上游 Retry-After）时取两者较大值），轮询时优先跳过；冷却到期自动恢复。
// 全部 key 都在冷却时不做排除（保可用性，失败总比无服务好）。
const KEY_COOLDOWN_BASE_MS = 60_000;
const KEY_COOLDOWN_MAX_MS = 10 * 60_000;

const failures = new Map<string, { count: number; until: number }>();

export function reportKeyFailure(key: string, cooldownMs?: number): void {
  if (!key) return;
  const prev = failures.get(key) || { count: 0, until: 0 };
  const count = prev.count + 1;
  const autoCooldown = Math.min(KEY_COOLDOWN_BASE_MS * 2 ** (count - 1), KEY_COOLDOWN_MAX_MS);
  const explicit = Number.isFinite(cooldownMs) ? Number(cooldownMs) : 0;
  failures.set(key, { count, until: Date.now() + Math.max(explicit, autoCooldown) });
}

export function reportKeySuccess(key: string): void {
  if (key) failures.delete(key);
}

function isCooling(key: string, now: number): boolean {
  const record = failures.get(key);
  return Boolean(record && record.until > now);
}

/** 解析可用 key 池：api_keys 数组在前、单 key 兜底；条目解析出各自的端点与模型名，去重去空。 */
export function resolveApiKeyPool(config: any): PooledKey[] {
  const mainBase = String(config?.base_url || '').trim();
  const mainModel = String(config?.model_name || '').trim();
  const out: PooledKey[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const line = typeof value === 'string' ? value.trim() : '';
    if (!line || seen.has(line)) return;
    seen.add(line);
    // 行格式：`key` / `key|Base URL` / `key|Base URL|模型名`（兼容全角｜分隔符）
    const parts = line
      .split(/[|｜]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const key = parts[0];
    if (!key) return;
    out.push({
      key,
      base_url: parts[1] || mainBase,
      model_name: parts[2] || mainModel,
    });
  };
  if (Array.isArray(config?.api_keys)) config.api_keys.forEach(push);
  push(config?.api_key);
  return out;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 逐请求轮询取条目（含各自端点/模型名）；优先跳过冷却中的坏条目；全部冷却时取最久未用的一个。
 *  任务级平台亲和：请求上下文携带 __poolAffinity（如 projectId:taskType:taskId）时，
 *  以稳定哈希锁定条目——同一任务的所有请求落在同一平台，避免单文档跨模型风格漂移；
 *  锁定的条目进入冷却时回退轮询（可用性优先，任务中途换平台好过整任务失败）。 */
export function pickRotatedApiKey(config: any): PooledKey | null {
  const pool = resolveApiKeyPool(config);
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const now = Date.now();
  const healthy = pool.filter((entry) => !isCooling(entry.key, now));
  const candidates = healthy.length > 0 ? healthy : pool;
  const affinity = String(config?.__poolAffinity || '');
  if (affinity && candidates.length === pool.length) {
    return candidates[hashString(affinity) % candidates.length];
  }
  const identity = `${config?.base_url || ''}|${config?.model_name || ''}`;
  const next = (counters.get(identity) || 0) + 1;
  counters.set(identity, next);
  return candidates[(next - 1) % candidates.length];
}
