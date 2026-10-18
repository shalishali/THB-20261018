// CORS 源白名单（H3 加固）：CORS_ORIGINS 环境变量，逗号分隔，如
//   CORS_ORIGINS=https://toubiaobiao.com,https://www.toubiaobiao.com
// 供 @fastify/cors（HTTP 路由）与 routes/events.ts（SSE hijack 手写头）共用，
// 保证两处放行规则永远一致。
//
// 未设置时返回 null = 保持旧行为（反射任意 Origin，dev 便利）；由调用方打印告警。
// 匹配时忽略末尾斜杠，避免 https://a.com/ 与 https://a.com 对不上。

export function getAllowedOrigins(): string[] | null {
  const raw = process.env.CORS_ORIGINS?.trim() || '';
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export function isOriginAllowed(origin: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  if (!origin) return false;
  return allowed.includes(origin.replace(/\/+$/, ''));
}
