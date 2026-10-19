// 用户管理路由（受保护 + requireAdmin——在 index.ts 装配时挂 createRequireAdmin preHandler）。
// 编辑账号（手机号不可改）+ 删除（禁删自己）。注册审批/停用启用已随 SaaS 自助注册模式移除（API-03）。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { getUser } from '../auth/middleware';
import { ASSIGNABLE_MODULE_IDS, parseModules } from '../auth/permissions';
import { writeAdminAudit } from '../audit/service';

const VALID_ROLES = ['admin', 'user'];

function publicUser(u: any): any {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    phone: u.phone,
    department: u.department,
    role: u.role,
    modules: parseModules(u.modules),
    createdAt: u.createdAt,
  };
}

export async function userRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // GET /users?page=1&pageSize=20&keyword=&role= → 分页 + 关键字筛选（手机号/用户名/姓名/部门）。
  // 仍返回 { users } 兼容旧调用；另附 total/page/pageSize/totalPages。
  app.get('/users', async (req) => {
    const query = (req.query ?? {}) as { page?: unknown; pageSize?: unknown; keyword?: unknown; role?: unknown };
    const keyword = String(query.keyword ?? '').trim().slice(0, 60);
    const role = typeof query.role === 'string' && VALID_ROLES.includes(query.role) ? query.role : '';
    const requestedPage = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
    const where: Prisma.UserWhereInput = {};
    if (role) where.role = role;
    if (keyword) {
      where.OR = [
        { phone: { contains: keyword, mode: 'insensitive' } },
        { username: { contains: keyword, mode: 'insensitive' } },
        { displayName: { contains: keyword, mode: 'insensitive' } },
        { department: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    const total = await prisma.user.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, username: true, displayName: true, phone: true, department: true,
        role: true, modules: true, createdAt: true, quotaChars: true, quotaUsedChars: true,
      },
    });
    // 累计充值（已核验 paid 订单汇总：金额 + 字数）——只汇总当前页用户，避免全表 groupBy。
    const pageUserIds = rows.map((row) => row.id);
    const sums = pageUserIds.length
      ? await prisma.quotaOrder.groupBy({
        by: ['userId'],
        where: { status: 'paid', userId: { in: pageUserIds } },
        _sum: { amountCents: true, chars: true },
      })
      : [];
    const rechargeMap = new Map<number, { amountCents: number; chars: number }>();
    for (const item of sums) {
      rechargeMap.set(item.userId, { amountCents: item._sum.amountCents || 0, chars: item._sum.chars || 0 });
    }
    return {
      users: rows.map((row) => ({
        ...publicUser(row),
        quotaChars: row.quotaChars,
        quotaUsedChars: row.quotaUsedChars,
        totalRechargeCents: rechargeMap.get(row.id)?.amountCents ?? 0,
        totalRechargeChars: rechargeMap.get(row.id)?.chars ?? 0,
      })),
      total,
      page,
      pageSize,
      totalPages,
      filters: { keyword, role },
    };
  });

  const paramId = (req: FastifyRequest): number => Number((req.params as { id?: string }).id);

  // PUT /users/:id → 编辑姓名/部门/角色/模板·格式权限位/重置密码。手机号不可改。
  app.put('/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const body = (req.body ?? {}) as {
      displayName?: string;
      department?: string;
      role?: string;
      modules?: string[];
      password?: string;
    };
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const data: Record<string, unknown> = {};
    if (typeof body.displayName === 'string') data.displayName = body.displayName.trim() || null;
    if (typeof body.department === 'string') data.department = body.department.trim() || null;
    if (typeof body.role === 'string') {
      if (!VALID_ROLES.includes(body.role)) return reply.code(400).send({ error: '角色取值：admin/user' });
      data.role = body.role;
    }
    // H1：角色实际变更时 +1 tokenVersion——被降权用户的旧 JWT（内含 admin claim）立即失效
    let shouldRevokeTokens = false;
    if (Array.isArray(body.modules)) {
      const allowed = new Set<string>(ASSIGNABLE_MODULE_IDS);
      const filtered: string[] = [];
      for (const m of body.modules) {
        if (typeof m !== 'string' || m === 'user-management') {
          return reply.code(400).send({ error: '非法模块权限项' });
        }
        if (allowed.has(m) && !filtered.includes(m)) filtered.push(m);
      }
      data.modules = JSON.stringify(filtered);
    }
    if (typeof body.password === 'string' && body.password.length >= 8) {
      data.password = await bcrypt.hash(body.password, 10);
      shouldRevokeTokens = true; // H1：管理员重置密码后，该用户已泄露/残留的旧令牌一并作废
    } else if (body.password !== undefined) {
      return reply.code(400).send({ error: '重置密码至少 8 位' });
    }
    if (typeof data.role === 'string' && data.role !== user.role) {
      shouldRevokeTokens = true;
    }
    if (shouldRevokeTokens) {
      data.tokenVersion = { increment: 1 };
    }
    if (!Object.keys(data).length) return reply.code(400).send({ error: '无待更新字段' });
    const updated = await prisma.user.update({ where: { id }, data });
    // 操作日志：记录管理员手动编辑用户（改了哪些字段；密码重置只记行为不记内容）
    await writeAdminAudit(prisma, getUser(req).id, id, 'user.update', {
      targetUsername: updated.username,
      fields: Object.keys(data).filter((key) => key !== 'tokenVersion'),
      passwordReset: Boolean(data.password),
      roleChangedTo: typeof data.role === 'string' ? data.role : undefined,
    });
    return { success: true, user: publicUser(updated) };
  });

  // DELETE /users/:id → 删除账户（禁删自己；admin 互删由前端确认）
  app.delete('/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const me = getUser(req);
    if (id === me.id) return reply.code(400).send({ error: '不能删除自己的账号' });
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    // 先记日志（用户删除后 targetUser 外键会置空，靠 detail 保留被删账号信息）
    await writeAdminAudit(prisma, me.id, id, 'user.delete', { targetUsername: user.username });
    await prisma.user.delete({ where: { id } });
    return { success: true, message: '账户已删除' };
  });
}
