import 'dotenv/config';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { touchLastActiveThrottled } from '../analytics/service';

const JWT_SECRET = process.env.JWT_SECRET?.trim() || '';

if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters');
}

export type JwtPurpose = 'access' | 'initial-password-change';

export interface JwtPayload {
  id: number;
  username: string;
  role: string;
  // H1 加固：签发时的用户 tokenVersion。与库中当前值不一致即视为已吊销。
  // 旧令牌无此字段时按 0 处理（用户 tokenVersion 默认 0，兼容升级）。
  tokenVersion?: number;
  purpose?: JwtPurpose;
}

export class TokenPurposeError extends Error {
  constructor(public readonly code: 'access-token-not-allowed' | 'invalid-token-purpose') {
    super(code === 'access-token-not-allowed'
      ? 'access token cannot be used for initial password change'
      : 'token purpose is invalid');
    this.name = 'TokenPurposeError';
  }
}

export function signToken(payload: Omit<JwtPayload, 'purpose'>): string {
  return jwt.sign({ ...payload, purpose: 'access' }, JWT_SECRET, { expiresIn: '7d' });
}

export function signInitialPasswordChangeToken(payload: Omit<JwtPayload, 'purpose'>): string {
  return jwt.sign({ ...payload, purpose: 'initial-password-change' }, JWT_SECRET, { expiresIn: '10m' });
}

export function verifyAccessToken(token: string): JwtPayload {
  const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { purpose?: unknown };
  if (payload.purpose !== undefined && payload.purpose !== 'access') {
    throw new TokenPurposeError('invalid-token-purpose');
  }
  return payload as JwtPayload;
}

export function verifyInitialPasswordChangeToken(token: string): JwtPayload {
  const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { purpose?: unknown };
  if (payload.purpose === undefined || payload.purpose === 'access') {
    throw new TokenPurposeError('access-token-not-allowed');
  }
  if (payload.purpose !== 'initial-password-change') {
    throw new TokenPurposeError('invalid-token-purpose');
  }
  return payload as JwtPayload;
}

// onRequest hook 工厂：校验 Authorization: Bearer <token>，失败即 401。
// H1 加固：JWT 本身无吊销能力，这里在验签后回查库做三重确认——
//   1) 用户仍存在（删除账号 → 幽灵 token 立即失效）；
//   2) tokenVersion 与签发时一致（改密/重置/角色变更时 +1，旧 token 全部吊销）；
//   3) 用库中的最新 role 覆盖 req.user（降权后旧 token 里的 admin claim 不再被信任）。
// 代价是每个受保护请求多一次主键查询，换来吊销语义完整；模块门禁等下游仍按需自查。
export function createVerifyToken(prisma: PrismaClient) {
  return async function verifyToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: '未登录' });
      return;
    }
    let payload: JwtPayload;
    try {
      payload = verifyAccessToken(header.slice(7));
    } catch {
      reply.code(401).send({ error: 'token 无效或已过期' });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, username: true, role: true, tokenVersion: true },
    });
    if (!user) {
      reply.code(401).send({ error: '账号不存在或已被删除' });
      return;
    }
    // 分析：节流更新最近活跃时间（≥10 分钟一次落库，避免每请求写库）
    touchLastActiveThrottled(prisma, user.id);
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      reply.code(401).send({ error: '登录状态已失效，请重新登录' });
      return;
    }
    (req as FastifyRequest & { user: JwtPayload }).user = {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };
  };
}

// 携带 projectId 的请求类型（requireProject 成功后挂载）。
export type ProjectScopedRequest = FastifyRequest & { user: JwtPayload; projectId: number };

// 从已通过 requireProject 的请求读取 projectId。
export function getProjectId(req: FastifyRequest): number {
  return (req as ProjectScopedRequest).projectId;
}

// 非项目作用域路由（ai / knowledge-base）按需读取 X-Project-Id 头（best-effort，不做鉴权）：
// 仅用于把 AI 上游错误 / KB 抽取进度路由到发起人当前项目的 SSE 通道；缺头时返回 undefined（事件丢弃）。
export function getProjectIdHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-project-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

// 从已鉴权请求读取 userId。
export function getUserId(req: FastifyRequest): number {
  return (req as FastifyRequest & { user: JwtPayload }).user.id;
}

export function getUser(req: FastifyRequest): JwtPayload {
  return (req as FastifyRequest & { user: JwtPayload }).user;
}

// preHandler 工厂：仅管理员通过。挂在 admin 专属路由组（users 等）。
export function createRequireAdmin() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    if (!user || user.role !== 'admin') {
      reply.code(403).send({ error: '需要管理员权限' });
    }
  };
}

// preHandler 工厂：解析 X-Project-Id 头、校验用户对该项目的访问权，挂 req.projectId。
// 挂在项目作用域路由组（technical-plan / duplicate-check / rejection-check / export / tasks）。
// SSE (/events) 用 ?projectId= 查询参数，不走此 preHandler，自行解析。
export function createRequireProject(prisma: PrismaClient) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    if (!user) {
      reply.code(401).send({ error: '未登录' });
      return;
    }
    const raw = req.headers['x-project-id'];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    const projectId = Number(headerValue);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      reply.code(400).send({ error: '缺少有效的 X-Project-Id 请求头' });
      return;
    }
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      reply.code(404).send({ error: '项目不存在' });
      return;
    }
    if (project.ownerId !== user.id && user.role !== 'admin') {
      reply.code(403).send({ error: '无权访问该项目' });
      return;
    }
    (req as ProjectScopedRequest).projectId = projectId;
  };
}
