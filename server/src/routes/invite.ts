import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { generateInviteCode } from './auth';

// API-14/15：邀请返利一期（仅落库与展示，不做结算/提现）。
// GET /api/invite/code      → 我的专属邀请码 + 邀请链接（幂等：已有直接返回，存量无码用户首次访问补生成）。
// GET /api/invite/promotion → 推广数据：邀请码/链接、邀请注册数量、累计待结算返利、下线分页列表。
// 数据隔离（API-08）：全部按 JWT user.id 作为 inviterId 过滤；下线姓名/手机号后端脱敏后最小披露。

function webBaseFrom(req: FastifyRequest): string {
  return (process.env.WEB_BASE_URL?.trim() || `http://${req.hostname}`).replace(/\/+$/, '');
}

// 下线展示脱敏：姓名保留首字（最多 3 个 *），手机号保留前 3 后 4；非手机号回退姓名脱敏。
function maskName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '-';
  if (trimmed.length === 1) return `${trimmed}*`;
  return `${trimmed.slice(0, 1)}${'*'.repeat(Math.min(trimmed.length - 1, 3))}`;
}

function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (/^1\d{10}$/.test(trimmed)) return `${trimmed.slice(0, 3)}****${trimmed.slice(7)}`;
  return maskName(trimmed);
}

// 幂等确保本人有专属邀请码：已有直接返回；无（存量用户）则生成并写回。
// 并发撞唯一约束（概率极低）时重读兜底，仍拿不到则返回本次生成值。
async function ensureInviteCode(prisma: PrismaClient, userId: number): Promise<string> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
  if (current?.inviteCode) return current.inviteCode;
  const code = await generateInviteCode(prisma);
  try {
    await prisma.user.update({ where: { id: userId }, data: { inviteCode: code } });
    return code;
  } catch {
    const reread = await prisma.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
    return reread?.inviteCode || code;
  }
}

export async function inviteRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // API-14：我的邀请码（生成/获取，幂等）。链接落点为登录页根路径 ?invite= 参数（FE-14 已支持自动填入注册表单）。
  app.get('/invite/code', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const inviteCode = await ensureInviteCode(prisma, user.id);
    return { inviteCode, inviteUrl: `${webBaseFrom(req)}/?invite=${inviteCode}` };
  });

  // API-15：我的邀请推广数据（下线分页）。一期返利仅统计 settleStatus=pending（无结算动作）。
  app.get('/invite/promotion', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const query = (req.query as Record<string, unknown>) || {};

    const page = Math.round(Number(query.page ?? 1));
    const pageSize = Math.round(Number(query.pageSize ?? 20));
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100) {
      reply.code(400);
      return { success: false, message: 'page/pageSize 取值非法（pageSize 上限 100）' };
    }

    const inviteCode = await ensureInviteCode(prisma, user.id);
    const inviteUrl = `${webBaseFrom(req)}/?invite=${inviteCode}`;
    const [inviteeCount, pendingSum, rows] = await Promise.all([
      prisma.inviteRelation.count({ where: { inviterId: user.id } }),
      prisma.rebateFlow.aggregate({
        where: { inviterId: user.id, settleStatus: 'pending' },
        _sum: { amount: true },
      }),
      prisma.inviteRelation.findMany({
        where: { inviterId: user.id },
        orderBy: { registeredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          registeredAt: true,
          status: true,
          invitee: { select: { displayName: true, username: true, phone: true } },
        },
      }),
    ]);

    // Prisma Decimal 金额以字符串透传（保精度，前端 toFixed 展示）；无流水返回 '0.00'。
    const pendingRebateAmount = pendingSum._sum.amount != null ? pendingSum._sum.amount.toString() : '0.00';

    return {
      inviteCode,
      inviteUrl,
      inviteeCount,
      pendingRebateAmount,
      page,
      pageSize,
      total: inviteeCount,
      items: rows.map((row) => {
        const displayName = row.invitee?.displayName || row.invitee?.username || '';
        const phone = row.invitee?.phone || row.invitee?.username || '';
        return {
          id: row.id,
          name: maskName(displayName),
          phone: maskPhone(phone),
          registeredAt: row.registeredAt,
          status: row.status,
        };
      }),
    };
  });
}
