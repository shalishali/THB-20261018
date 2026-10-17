// 用户/IP 维度基础接口限流（API-11）：进程内固定窗口计数器。
// 单实例部署够用；多实例横向扩容时需换 Redis 共享计数（二期）。
// 挂载方式：路由级 onRequest（在 verifyToken 之后注册时 req.user 已可用，按 userId 计数；
// 公开路由（登录/注册/找回密码）无 user，按客户端 IP 计数）。
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from './middleware';

export interface RateLimitOptions {
  name: string; // 桶名，隔离不同接口的计数
  windowMs: number; // 固定窗口长度（毫秒）
  max: number; // 窗口内允许的最大请求数
  keyBy?: 'user' | 'ip'; // 业务路由按 user；公开认证路由按 ip
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = Date.now();
// M3 加固：桶总量上限。IP 维度桶的 key 可被外部输入撑大（伪造 XFF 等），惰性清扫只删过期桶，
// 高速注入新 key 时 Map 仍会无界增长 → 内存耗尽。到顶后先强制清过期，仍不够就按插入序淘汰最旧桶
// （最旧桶大概率已接近窗口尾声，误伤有限）。多实例共享计数（Redis）仍是二期方向。
const MAX_BUCKETS = Number(process.env.RATE_LIMIT_MAX_BUCKETS) > 0
  ? Number(process.env.RATE_LIMIT_MAX_BUCKETS)
  : 10_000;

// 反代场景取 X-Forwarded-For 首段（deploy/nginx 已 proxy_set_header）；否则用 socket 地址。
// 导出供注册反作弊（DB-22）复用。
export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (first) return first.split(',')[0].trim();
  return req.ip || 'unknown';
}

// 惰性清扫过期桶，防止 Map 无限膨胀（每分钟最多一次全量扫描）。
function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evictIfNeeded(key: string, now: number): void {
  if (buckets.size < MAX_BUCKETS || buckets.has(key)) return;
  for (const [existingKey, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(existingKey);
  }
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (oldest.done || oldest.value === undefined) break;
    buckets.delete(oldest.value);
  }
}

export function createRateLimit(options: RateLimitOptions) {
  const { name, windowMs, max, keyBy = 'user' } = options;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    sweep(now);
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    const identity = keyBy === 'user' && user ? `u:${user.id}` : `ip:${clientIp(req)}`;
    const key = `${name}:${identity}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      evictIfNeeded(key, now);
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      reply.header('Retry-After', String(retryAfterSec));
      reply.code(429).send({ error: '请求过于频繁，请稍后再试' });
    }
  };
}
