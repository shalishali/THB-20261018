import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';

// API-13：AI 调用记录查询（FE-17 数据源）。
// GET /api/stats/ai-usage?days=30&page=1&pageSize=20&userId=&keyword=
// 普通用户仅返回本人（API-08 userId 隔离）；管理员返回全站数据并附带「按用户」维度。
// 筛选：userId（管理员按用户）/ keyword（项目名称/编号/ID 模糊匹配），作用于所有聚合与明细。
// 一期只读展示，不做扣费。
const IMAGE_MODEL_PATTERN = /image|seedream|dall-?e|flux|imagen|wanx|kling|nano-banana/i;

function isImageUsageRow(row: { bizType: string; model: string; provider: string }): boolean {
  if (row.bizType === 'image') return true;
  return IMAGE_MODEL_PATTERN.test(`${row.model || ''} ${row.provider || ''}`);
}

function toPositiveInt(value: unknown): number | null {
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num > 0 ? num : null;
}

export async function statsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/stats/ai-usage', async (req: FastifyRequest, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const isAdmin = user.role === 'admin';
    const query = (req.query as Record<string, unknown>) || {};

    const days = Math.round(Number(query.days ?? 30));
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      reply.code(400);
      return { success: false, message: 'days 取值范围 1~366' };
    }
    const page = Math.round(Number(query.page ?? 1));
    const pageSize = Math.round(Number(query.pageSize ?? 20));
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100) {
      reply.code(400);
      return { success: false, message: 'page/pageSize 取值非法（pageSize 上限 100）' };
    }

    // 筛选参数：userId 仅管理员生效（普通用户仍被 userId 隔离）；keyword 匹配项目名称/编号/ID。
    const filterUserId = isAdmin ? toPositiveInt(query.userId) : null;
    const keyword = String(query.keyword ?? '').trim().slice(0, 60);
    const keywordLower = keyword.toLowerCase();

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // 记录量级小（全站日均几十~几百条）：窗口内全量拉取后内存过滤/聚合，避免 groupBy/多查询。
    const rows = await prisma.aiCallStat.findMany({
      where: { ...(isAdmin ? {} : { userId: user.id }), createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, userId: true, projectId: true, provider: true, model: true, bizType: true, callCount: true,
        inputTokens: true, outputTokens: true, inputChars: true, outputChars: true, createdAt: true,
      },
    });

    // 项目信息（名称/编号/归属）——过滤关键字与展示都要用；项目删除时用调用记录 userId 兜底归属。
    const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is number => id != null))];
    const projectRows = projectIds.length
      ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, projectCode: true, ownerId: true } })
      : [];
    const projectInfoMap = new Map(projectRows.map((p) => [p.id, p]));

    const userIds = [...new Set(rows.map((row) => row.userId))];
    const userRows = isAdmin && userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
      : [];
    const userNameMap = new Map(userRows.map((u) => [u.id, u.displayName?.trim() || u.username]));
    // 非管理员：明细/项目行的用户名就是自己，无需额外查询。
    if (!isAdmin) userNameMap.set(user.id, user.username);

    const projectLabel = (pid: number | null): string => {
      if (pid == null) return '';
      const info = projectInfoMap.get(pid);
      if (!info) return `项目 #${pid}`;
      return `${info.projectCode || ''} ${info.name || ''} #${pid}`;
    };
    const keywordMatchesProject = (pid: number | null): boolean => {
      if (!keywordLower) return true;
      if (pid == null) return false;
      const info = projectInfoMap.get(pid);
      const haystack = `${info?.projectCode || ''} ${info?.name || ''} #${pid} ${pid}`.toLowerCase();
      if (haystack.includes(keywordLower)) return true;
      // 项目已删除时只能按「项目 #id」或 id 匹配
      return !info && (String(pid).includes(keywordLower) || `项目 #${pid}`.includes(keywordLower));
    };

    // 过滤后的行：所有聚合/明细都以它为准
    const filteredRows = rows.filter((row) => {
      if (filterUserId != null && row.userId !== filterUserId) return false;
      return keywordMatchesProject(row.projectId);
    });

    const totals = {
      calls: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0,
    };
    const byBizType: Record<string, { calls: number; inputChars: number; outputChars: number; inputTokens: number; outputTokens: number }> = {};
    const projectMap = new Map<number, { calls: number; inputTokens: number; outputTokens: number; textTokens: number; imageTokens: number; imageCalls: number; ownerId: number | null }>();
    const userMap = new Map<number, { calls: number; inputTokens: number; outputTokens: number; inputChars: number; outputChars: number }>();
    for (const row of filteredRows) {
      totals.calls += row.callCount;
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.inputChars += row.inputChars;
      totals.outputChars += row.outputChars;
      const bucket = (byBizType[row.bizType] ||= { calls: 0, inputChars: 0, outputChars: 0, inputTokens: 0, outputTokens: 0 });
      bucket.calls += row.callCount;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.inputChars += row.inputChars;
      bucket.outputChars += row.outputChars;

      const userBucket = userMap.get(row.userId) || { calls: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0 };
      userBucket.calls += row.callCount;
      userBucket.inputTokens += row.inputTokens;
      userBucket.outputTokens += row.outputTokens;
      userBucket.inputChars += row.inputChars;
      userBucket.outputChars += row.outputChars;
      userMap.set(row.userId, userBucket);

      if (row.projectId != null) {
        const proj = projectMap.get(row.projectId) || { calls: 0, inputTokens: 0, outputTokens: 0, textTokens: 0, imageTokens: 0, imageCalls: 0, ownerId: row.userId ?? null };
        if (proj.ownerId == null && row.userId != null) proj.ownerId = row.userId;
        proj.calls += row.callCount;
        proj.inputTokens += row.inputTokens;
        proj.outputTokens += row.outputTokens;
        if (isImageUsageRow(row)) {
          proj.imageTokens += row.inputTokens + row.outputTokens;
          proj.imageCalls += row.callCount;
        } else {
          proj.textTokens += row.inputTokens + row.outputTokens;
        }
        projectMap.set(row.projectId, proj);
      }
    }

    const byProject = [...projectMap.entries()].map(([pid, proj]) => {
      const info = projectInfoMap.get(pid);
      const ownerId = info?.ownerId ?? proj.ownerId ?? null;
      return {
        projectId: pid,
        projectCode: info?.projectCode || '',
        projectName: info?.name || `项目 #${pid}`,
        projectDeleted: !info,
        ownerId,
        ownerName: ownerId != null ? (userNameMap.get(ownerId) || '') : '',
        calls: proj.calls,
        inputTokens: proj.inputTokens,
        outputTokens: proj.outputTokens,
        textTokens: proj.textTokens,
        imageTokens: proj.imageTokens,
        imageCalls: proj.imageCalls,
      };
    }).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

    const byUser = [...userMap.entries()]
      .map(([userId, v]) => ({ userId, username: userNameMap.get(userId) || `用户 #${userId}`, ...v }))
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

    // 筛选下拉选项：来自全量（未筛选）数据，避免选了用户后下拉只剩一个人。
    const filterUserIds = [...new Set(rows.map((row) => row.userId))];
    const filterUsers = isAdmin
      ? filterUserIds.map((id) => ({ userId: id, username: userNameMap.get(id) || `用户 #${id}` }))
        .sort((a, b) => a.userId - b.userId)
      : [];

    // ===== 多维度聚合：每日趋势 / 按模型 / 按服务商 =====
    const dayMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
    const modelMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number; label: string }>();
    const providerMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number; label: string }>();
    for (const row of filteredRows) {
      const dayKey = (row.createdAt as Date).toISOString().slice(0, 10);
      const dayBucket = dayMap.get(dayKey) || { calls: 0, inputTokens: 0, outputTokens: 0 };
      dayBucket.calls += row.callCount;
      dayBucket.inputTokens += row.inputTokens;
      dayBucket.outputTokens += row.outputTokens;
      dayMap.set(dayKey, dayBucket);

      const modelKey = `${row.provider}/${row.model}`;
      const modelBucket = modelMap.get(modelKey) || { calls: 0, inputTokens: 0, outputTokens: 0, label: row.model || row.provider };
      modelBucket.calls += row.callCount;
      modelBucket.inputTokens += row.inputTokens;
      modelBucket.outputTokens += row.outputTokens;
      modelMap.set(modelKey, modelBucket);

      const providerKey = row.provider || '未知';
      const providerBucket = providerMap.get(providerKey) || { calls: 0, inputTokens: 0, outputTokens: 0, label: providerKey };
      providerBucket.calls += row.callCount;
      providerBucket.inputTokens += row.inputTokens;
      providerBucket.outputTokens += row.outputTokens;
      providerMap.set(providerKey, providerBucket);
    }

    const byDay = [...dayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, ...v }));
    const byModel = [...modelMap.entries()]
      .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
      .map(([key, v]) => ({ key, label: v.label, calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens }));
    const byProvider = [...providerMap.entries()]
      .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
      .map(([key, v]) => ({ key, label: v.label, calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens }));

    const start = (page - 1) * pageSize;
    return {
      days,
      page,
      pageSize,
      scope: isAdmin ? 'all' : 'self',
      filters: { userId: filterUserId, keyword },
      filterOptions: { users: filterUsers },
      totalRows: filteredRows.length,
      totals,
      byBizType,
      byProject,
      byUser,
      byDay,
      byModel,
      byProvider,
      items: filteredRows.slice(start, start + pageSize).map((row) => ({
        ...row,
        username: userNameMap.get(row.userId) || `用户 #${row.userId}`,
      })),
    };
  });
}
