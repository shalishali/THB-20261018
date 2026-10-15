import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { createRateLimit } from '../auth/rateLimit';

// 受保护路由（需登录）：问题FAQ（公开问答板）。
// 所有登录用户可见全部问题与回复；任意用户可发问；admin 可回复任意、改任意状态；
// 反馈提交者可追加回复/关闭自己的反馈（普通用户之间不互相回复）。
//   GET    /api/feedback          → 列表（不含 images，减负载；全员可见）
//   GET    /api/feedback/:id      → 详情（含 replies + images；全员可见）
//   POST   /api/feedback          → 新建（body: {content, images?}）
//   POST   /api/feedback/:id/replies → 回复（body: {content, images?}）
//   PATCH  /api/feedback/:id/status → 改状态（body: {status}）
const MAX_IMAGES = 4;
const ALLOWED_STATUS = new Set(['open', 'resolved', 'closed']);
// API-09：截图为 base64 data URL（JSON body 内联），限制单张大小（base64 后约 3MB ≈ 原图 2.2MB）。
const MAX_IMAGE_DATAURL_LENGTH = 3 * 1024 * 1024;

type RequestWithUser = FastifyRequest & { user: JwtPayload };
type RequestWithBody = RequestWithUser & { body: unknown };
const paramId = (req: FastifyRequest): number => Number((req.params as { id: string }).id);

// API-09：仅接受 data:image/ 开头的 data URL，且单张不超限。
function sanitizeImages(raw: unknown[]): { images: string[] } | { error: string } {
  const images = raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_IMAGES);
  for (const image of images) {
    if (!image.startsWith('data:image/')) {
      return { error: '截图仅支持图片格式' };
    }
    if (image.length > MAX_IMAGE_DATAURL_LENGTH) {
      return { error: '单张截图过大（约 3MB 上限），请压缩后重试' };
    }
  }
  return { images };
}

export async function feedbackRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // API-11：工单创建/回复按用户限流（10 次/分钟），防刷屏。
  const feedbackWriteRateLimit = createRateLimit({ name: 'feedback-write', windowMs: 60_000, max: 10 });

  app.get('/feedback', async () => {
    // 公开问答板：所有登录用户可见全部问题（不再按 userId 过滤）。
    const rows = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { displayName: true, username: true } },
        _count: { select: { replies: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.user.displayName ?? r.user.username,
      content: r.content,
      status: r.status,
      replyCount: r._count.replies,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });

  app.get('/feedback/:id', async (req, reply) => {
    const id = paramId(req);
    const fb = await prisma.feedback.findUnique({
      where: { id },
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { displayName: true, username: true } } },
        },
      },
    });
    if (!fb) return reply.code(404).send({ error: '反馈不存在' });
    // 公开问答板：任何登录用户可查看任意问题详情与回复。
    return {
      id: fb.id,
      userId: fb.userId,
      displayName: fb.user?.displayName ?? fb.user?.username ?? '',
      content: fb.content,
      images: fb.images ?? [],
      status: fb.status,
      createdAt: fb.createdAt,
      updatedAt: fb.updatedAt,
      replies: fb.replies.map((rp) => ({
        id: rp.id,
        userId: rp.userId,
        displayName: rp.user.displayName ?? rp.user.username,
        content: rp.content,
        images: rp.images ?? [],
        isAdmin: rp.isAdmin,
        createdAt: rp.createdAt,
      })),
    };
  });

  app.post('/feedback', { onRequest: feedbackWriteRateLimit }, async (req, reply) => {
    const user = (req as RequestWithBody).user;
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) return reply.code(400).send({ error: '请填写问题描述' });
    const rawImages = Array.isArray(body?.images) ? (body!.images as unknown[]) : [];
    const checked = sanitizeImages(rawImages);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const { images } = checked;

    const created = await prisma.feedback.create({
      data: { userId: user.id, content, images },
    });
    return { id: created.id };
  });

  app.post('/feedback/:id/replies', { onRequest: feedbackWriteRateLimit }, async (req, reply) => {
    const user = (req as RequestWithBody).user;
    const id = paramId(req);
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) return reply.code(400).send({ error: '请填写回复内容' });
    const rawImages = Array.isArray(body?.images) ? (body!.images as unknown[]) : [];
    const checked = sanitizeImages(rawImages);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const { images } = checked;

    const fb = await prisma.feedback.findUnique({ where: { id }, select: { userId: true } });
    if (!fb) return reply.code(404).send({ error: '反馈不存在' });
    if (user.role !== 'admin' && fb.userId !== user.id) {
      return reply.code(403).send({ error: '无权回复该反馈' });
    }

    const created = await prisma.feedbackReply.create({
      data: { feedbackId: id, userId: user.id, content, images, isAdmin: user.role === 'admin' },
    });
    // 回复后把反馈状态从 closed 重置回 open，确保继续跟进。
    await prisma.feedback.update({
      where: { id },
      data: { status: 'open', updatedAt: new Date() },
    });
    return { id: created.id };
  });

  app.patch('/feedback/:id/status', async (req, reply) => {
    const user = (req as RequestWithBody).user;
    const id = paramId(req);
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const status = typeof body?.status === 'string' ? body.status : '';
    if (!ALLOWED_STATUS.has(status)) return reply.code(400).send({ error: '无效的状态' });

    const fb = await prisma.feedback.findUnique({ where: { id }, select: { userId: true } });
    if (!fb) return reply.code(404).send({ error: '反馈不存在' });
    // 普通用户仅可关闭自己的反馈；admin 可改任意状态。
    if (user.role !== 'admin' && (fb.userId !== user.id || status !== 'closed')) {
      return reply.code(403).send({ error: '无权修改该反馈状态' });
    }

    await prisma.feedback.update({ where: { id }, data: { status } });
    return { id, status };
  });
}
