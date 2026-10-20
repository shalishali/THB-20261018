// 项目路由（受保护、非项目作用域——管理项目本身，不走 requireProject）。
// 对标 92：项目为中心。仪表盘消费 list/stats；technical-plan 等域路由按 X-Project-Id 进入具体项目。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUser } from '../auth/middleware';
import { trackActivity } from '../analytics/service';
import { clientIp } from '../auth/rateLimit';
import { createWorkspacePaths } from '../document/paths';
import {
  normalizeSubjectReplacements,
  serializeSubjectReplacements,
  type SubjectReplacement,
} from '../tasks/utils/subjectReplacement';

// 工作区表族（按 projectId 分区）。删项目时逐表 deleteMany 清业务数据（表族无外键连 Project）。
const WORKSPACE_MODELS = [
  'technicalPlanMeta', 'technicalPlanTask', 'technicalPlanBidItem',
  'technicalPlanOutlineNode', 'technicalPlanContentSection', 'technicalPlanContentPlan', 'technicalPlanGlobalFactGroup',
  // 已裁剪模块的表已删除（TechnicalPlanReferenceDoc / ResponseDeviation*），勿再列入，否则 prisma client 取不到 → 500
  'duplicateCheckMeta', 'duplicateCheckTask', 'duplicateCheckAnalysisSection', 'duplicateCheckFile',
  'duplicateCheckContentFile', 'duplicateCheckMetadataItem', 'duplicateCheckOutlineItem', 'duplicateCheckOutlineGroup',
  'duplicateCheckOutlinePairwise', 'duplicateCheckContentDuplicate', 'duplicateCheckContentOccurrence',
  'duplicateCheckImageFile', 'duplicateCheckDuplicateImage', 'duplicateCheckImageOccurrence',
  'rejectionCheckMeta', 'rejectionCheckDocument', 'rejectionCheckTask', 'rejectionCheckExtraction',
  'rejectionCheckResult', 'rejectionCheckRiskFinding', 'rejectionCheckTypoFinding', 'rejectionCheckLogicFinding',
] as const;

// 仪表盘进度：由 technical_plan_meta.step 推算百分比（与 isValidStep 的 6 个步骤对齐）。
const STEP_PROGRESS: Record<string, number> = {
  'document-analysis': 10,
  'bid-analysis': 25,
  'outline-generation': 45,
  'global-facts': 65,
  'content-edit': 85,
};

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

async function nextProjectCode(prisma: PrismaClient, year: number, ownerId: number): Promise<string> {
  // 按用户隔离编号：每个用户自己的项目序号从 0001 递增，不与其他用户混编。
  // 必须取「已有最大序号 + 1」而不是 count+1：删掉中间某个项目后 count 会倒退，
  // 与仍存在的编号撞上 @@unique([ownerId, projectCode]) 直接 P2002（新建项目 500）。
  const prefix = `XM${year}-`;
  const rows = await prisma.project.findMany({
    where: { ownerId, projectCode: { startsWith: prefix } },
    select: { projectCode: true },
  });
  let maxSeq = 0;
  for (const row of rows) {
    const seq = Number(row.projectCode.slice(prefix.length));
    if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}${pad4(maxSeq + 1)}`;
}

// 仪表盘进度：正文完成 + 导出过 → 100%（项目全流程到此结束，expand 步骤不参与）。
// 否则按 technical_plan_meta.step 查表推算。complete 可由调用方传入避免重复查 outline。
async function progressOf(prisma: PrismaClient, projectId: number, complete?: boolean): Promise<number> {
  const meta = await (prisma as any).technicalPlanMeta.findUnique({ where: { projectId }, select: { step: true } });
  if (!meta) return 0;
  const stepProgress = STEP_PROGRESS[meta.step as string] ?? 5;
  const isDone = complete !== undefined ? complete : await isProjectComplete(prisma, projectId);
  if (isDone) {
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { lastExportedAt: true } });
    if (proj?.lastExportedAt) return 100;
  }
  return stepProgress;
}

// 第3/4/5点完成度判定：存在大纲且所有叶子节点正文(content)非空 → 已完成标书生成全流程。
async function isProjectComplete(prisma: PrismaClient, projectId: number): Promise<boolean> {
  const nodes = await (prisma as any).technicalPlanOutlineNode.findMany({
    where: { projectId },
    select: { nodeId: true, parentNodeId: true, content: true },
  });
  if (!nodes.length) return false;
  const parentIds = new Set(nodes.map((n: any) => n.parentNodeId).filter(Boolean));
  const leaves = nodes.filter((n: any) => !parentIds.has(n.nodeId));
  if (!leaves.length) return false;
  return leaves.every((n: any) => (n.content ?? '').trim().length > 0);
}

// 完成率统计口径与 progressOf 的 100% 一致：isProjectComplete 且已导出（lastExportedAt 非空）。
// 不能用 status='completed' 计数——系统从不把 status 置为 completed（无 UI 触发），那样完成率恒为 0。
async function countCompleted(prisma: PrismaClient, where: Record<string, unknown>): Promise<number> {
  const rows = await prisma.project.findMany({ where, select: { id: true, lastExportedAt: true } });
  let n = 0;
  for (const r of rows) {
    if (r.lastExportedAt && (await isProjectComplete(prisma, r.id))) n++;
  }
  return n;
}

// 写 UserConfig.data.activeProjectId（绕过 saveUserConfig 白名单——activeProjectId 不是偏好字段）。
async function activateProject(prisma: PrismaClient, userId: number, projectId: number): Promise<void> {
  const row = await (prisma as any).userConfig.upsert({
    where: { userId },
    update: {},
    create: { userId, data: {} },
  });
  const data = (row.data && typeof row.data === 'object' ? row.data : {}) as Record<string, unknown>;
  if (data.activeProjectId !== projectId) {
    await (prisma as any).userConfig.update({
      where: { userId },
      data: { data: { ...data, activeProjectId: projectId } },
    });
  }
}

export async function projectRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // GET /projects → 项目列表（owner=self；admin 见全部），附 ownerName（创建人）+ progress（仪表盘进度条）。
  app.get('/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getUser(req);
    const where = user.role === 'admin' ? {} : { ownerId: user.id };
    const rows = await prisma.project.findMany({ where, orderBy: { updatedAt: 'desc' } });
    const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
    const owners = ownerIds.length
      ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true, username: true } })
      : [];
    const ownerMap = new Map(owners.map((o) => [o.id, o]));
    // 是否正在生成方案（任务引擎里 status=running/pausing 的 technical-plan 任务）。
    // 列表/新建守卫都以「生成中」为准：未完成但空闲的项目不应阻止新建（2026-10-19 修正）。
    const projectIds = rows.map((r) => r.id);
    const runningRows = projectIds.length
      ? await (prisma as any).technicalPlanTask.findMany({
          where: { projectId: { in: projectIds }, status: { in: ['running', 'pausing'] } },
          select: { projectId: true },
        })
      : [];
    const generatingIds = new Set<number>(runningRows.map((r: { projectId: number }) => r.projectId));
    // 逐项目推算进度（technical_plan_meta.step → %）。项目数通常很少，逐条可接受。
    const withProgress = await Promise.all(
      rows.map(async (r) => {
        const isComplete = await isProjectComplete(prisma, r.id);
        return {
          id: r.id,
          projectCode: r.projectCode,
          name: r.name,
          description: r.description,
          bidderName: r.bidderName,
          workflowKind: r.workflowKind,
          subjectReplacements: normalizeSubjectReplacements(r.subjectReplacements),
          // 状态口径与仪表盘卡片一致：完成判定只看 isProjectComplete（系统从不把 status 置为 completed），
          // 否则列表里所有项目都会显示「进行中」，与卡片数字互相矛盾。
          status: isComplete ? 'completed' : r.status,
          ownerId: r.ownerId,
          ownerName: ownerMap.get(r.ownerId)?.displayName || ownerMap.get(r.ownerId)?.username || '',
          progress: await progressOf(prisma, r.id, isComplete),
          isComplete,
          isGenerating: generatingIds.has(r.id),
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
    );
    return withProgress;
  });

  // GET /projects/stats → 仪表盘卡片：项目总数 / 进行中任务 / 本月新增 / 完成率。
  app.get('/projects/stats', async (req: FastifyRequest) => {
    const user = getUser(req);
    const where = user.role === 'admin' ? {} : { ownerId: user.id };
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [total, active, thisMonth, completed] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.count({ where: { ...where, status: 'active' } }),
      prisma.project.count({ where: { ...where, createdAt: { gte: monthStart } } }),
      countCompleted(prisma, where),
    ]);
    // runningTasks 按 owner 项目集过滤（管理员仍全局），避免普通用户看到全局任务计数。
    let runningTasks: number;
    if (user.role === 'admin') {
      runningTasks = await (prisma as any).technicalPlanTask.count({ where: { status: 'running' } });
    } else {
      const ownerProjects = await prisma.project.findMany({ where, select: { id: true } });
      const ids = ownerProjects.map((p) => p.id);
      runningTasks = ids.length
        ? await (prisma as any).technicalPlanTask.count({ where: { status: 'running', projectId: { in: ids } } })
        : 0;
    }
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    // 进行中项目 = 未完成项目（total - completed）。这是页面上「进行中」徽标与卡片数字的共同口径；
    // 原先卡片数 technical_plan_task.status='running'，服务器重启后内存任务丢失即恒为 0，
    // 与列表里十几个「进行中」直接矛盾（2026-10-19 修复）。
    const inProgress = Math.max(0, total - completed);
    return { total, active, thisMonth, completionRate, runningTasks, inProgress };
  });

  // POST /projects { name, description? } → 新建（服务端生成 projectCode，自动激活）。
  app.post('/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getUser(req);
    const body = (req.body ?? {}) as { name?: string; description?: string; bidderName?: string; workflowKind?: string };
    // 新建守卫：只有「正在生成方案」时才拦（普通用户）。未完成但空闲的项目不阻止新建。
    // 管理员豁免：后台需要随时建项目做运维/演示。
    if (user.role !== 'admin') {
      const owned = await prisma.project.findMany({ where: { ownerId: user.id }, select: { id: true, projectCode: true } });
      const ownedIds = owned.map((p) => p.id);
      const running = ownedIds.length
        ? await (prisma as any).technicalPlanTask.findFirst({
            where: { projectId: { in: ownedIds }, status: { in: ['running', 'pausing'] } },
            select: { projectId: true },
            orderBy: { updatedAt: 'desc' },
          })
        : null;
      if (running) {
        const conflict = owned.find((p) => p.id === running.projectId);
        return reply.code(409).send({
          error: `你有项目正在生成方案（编号 ${conflict?.projectCode ?? ''}），请等待完成或删除后再新建项目。`,
          conflictingProjectCode: conflict?.projectCode,
        });
      }
    }
    const year = new Date().getFullYear();
    const bidderName = (body.bidderName || '').trim();
    // 并发创建时两个请求可能算到同一个编号：唯一约束（ownerId+projectCode）兜底，
    // 命中 P2002 就重算重试；连续 5 次仍冲突说明该用户当年编号已乱，回 409 让前端重试。
    const createWithUniqueCode = async () => {
      for (let attempt = 0; ; attempt += 1) {
        const projectCode = await nextProjectCode(prisma, year, user.id);
        // 仪表盘"上传招标文件"直达流：允许空名称，先以项目编号占位；
        // 目录生成完成后会用解析出的项目名称自动回填（见 outline-generation runner）。
        const name = (body.name || '').trim() || projectCode;
        try {
          return await prisma.project.create({
            data: {
              projectCode,
              name,
              description: (body.description || '').trim(),
              bidderName: bidderName || null,
              ownerId: user.id,
              status: 'active',
              workflowKind: (body as any).workflowKind || null,
            },
          });
        } catch (error) {
          if ((error as { code?: string })?.code === 'P2002' && attempt < 4) continue;
          throw error;
        }
      }
    };
    // 5 次重试后仍命中 P2002 → 返回 409，交给前端重试（不把 Prisma 原始错误抛成 500）。
    const p = await createWithUniqueCode().catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'P2002') return null;
      throw error;
    });
    if (!p) {
      return reply.code(409).send({ error: '项目编号生成冲突，请稍后重试' });
    }
    await activateProject(prisma, user.id, p.id);
    void trackActivity(prisma, user.id, 'project.create', { projectCode: p.projectCode, autoNamed: p.name === p.projectCode }, clientIp(req));
    return {
      id: p.id, projectCode: p.projectCode, name: p.name, description: p.description, workflowKind: p.workflowKind,
      bidderName: p.bidderName,
      status: p.status, ownerId: p.ownerId, createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  });

  const ensureAccess = async (req: FastifyRequest): Promise<{ project: { id: number; ownerId: number } } | { error: string; code: number }> => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(id) || id <= 0) return { error: '无效的项目 id', code: 400 };
    const p = await prisma.project.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!p) return { error: '项目不存在', code: 404 };
    const user = getUser(req);
    if (p.ownerId !== user.id && user.role !== 'admin') return { error: '无权访问该项目', code: 403 };
    return { project: p };
  };

  // GET /projects/:id → 详情（含进度）。
  app.get('/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await ensureAccess(req);
    if ('error' in access) return reply.code(access.code).send({ error: access.error });
    const p = await prisma.project.findUnique({ where: { id: access.project.id } });
    const isComplete = await isProjectComplete(prisma, access.project.id);
    const progress = await progressOf(prisma, access.project.id, isComplete);
    const { subjectReplacements: rawReplacements, ...rest } = (p || {}) as { subjectReplacements?: string | null } & Record<string, unknown>;
    return { ...rest, subjectReplacements: normalizeSubjectReplacements(rawReplacements), progress, isComplete };
  });

  // PATCH /projects/:id { name?, description?, status? }
  app.patch('/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await ensureAccess(req);
    if ('error' in access) return reply.code(access.code).send({ error: access.error });
    const body = (req.body ?? {}) as { name?: string; description?: string; status?: string; bidderName?: string; subjectReplacements?: SubjectReplacement[] };
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body.description === 'string') data.description = body.description;
    if (typeof body.bidderName === 'string') data.bidderName = body.bidderName.trim();
    if (body.subjectReplacements !== undefined) data.subjectReplacements = serializeSubjectReplacements(normalizeSubjectReplacements(body.subjectReplacements));
    if (typeof body.status === 'string' && ['draft', 'active', 'submitted', 'completed'].includes(body.status)) data.status = body.status;
    if (!Object.keys(data).length) return reply.code(400).send({ error: '无待更新字段' });
    const p = await prisma.project.update({ where: { id: access.project.id }, data });
    return p;
  });

  // DELETE /projects/:id → 级联清工作区表 + 删 FS 目录 + 删项目。不允许删默认项目可放宽（前端确认）。
  app.delete('/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await ensureAccess(req);
    if ('error' in access) return reply.code(access.code).send({ error: access.error });
    const projectId = access.project.id;
    // 1) 清项目工作区表
    await Promise.all(
      WORKSPACE_MODELS.map((m) => (prisma as any)[m].deleteMany({ where: { projectId } })),
    );
    // 2) 清 FS 目录（best-effort）：删项目根目录，避免遗留空目录/其他项目级文件
    try {
      const paths = createWorkspacePaths(projectId);
      await fs.rm(path.dirname(paths.workspaceDir), { recursive: true, force: true });
    } catch {
      /* 目录可能不存在，忽略 */
    }
    // 3) 删项目
    await prisma.project.delete({ where: { id: projectId } });
    return { success: true, message: '项目已删除' };
  });

  // POST /projects/:id/activate → 写当前用户 UserConfig.data.activeProjectId。
  app.post('/projects/:id/activate', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await ensureAccess(req);
    if ('error' in access) return reply.code(access.code).send({ error: access.error });
    const user = getUser(req);
    await activateProject(prisma, user.id, access.project.id);
    return { success: true, activeProjectId: access.project.id };
  });
}
