import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import { verifyAccessToken } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { getSystemSettings, saveSystemSettings } from '../config/store';
import { writeAdminAudit } from '../audit/service';

// 基本设置（系统名称 + Logo）。
// GET /api/system-settings：公开（登录页需要在鉴权前展示系统名称/Logo）。
export async function systemSettingsPublicRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/system-settings', async (req) => {
    const settings = await getSystemSettings(prisma);
    // 邀请海报可能较大（data URL），只在管理员请求时返回；普通登录页/推广页不背这份负载。
    let isAdmin = false;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        isAdmin = verifyAccessToken(header.slice(7)).role === 'admin';
      } catch {
        isAdmin = false;
      }
    }
    return isAdmin ? settings : { ...settings, invitePosterDataUrl: null, supportQrDataUrl: null, groupQrDataUrl: null };
  });

  // 客服/加群二维码：侧栏弹窗使用，登录后所有用户都需要，公开读取（不含其他系统设置）。
  app.get('/support-config', async () => {
    const settings = await getSystemSettings(prisma);
    return {
      supportQrDataUrl: settings.supportQrDataUrl,
      groupQrDataUrl: settings.groupQrDataUrl,
    };
  });
}

// PUT /api/system-settings：仅管理员（写平台级基本设置）。
export async function systemSettingsAdminRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // PUT /api/system-settings：仅管理员（写平台级基本设置）。
  // 基本设置包含 Logo/海报/二维码 data URL，可能超过 Fastify 默认 1MiB JSON 限制，单独放宽到 10MiB。
  app.put('/system-settings', { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role !== 'admin') {
      reply.code(403);
      return { success: false, message: '仅管理员可修改基本设置' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body as { systemName?: string; logoDataUrl?: string | null; invitePromoCopy?: string; invitePosterDataUrl?: string | null; supportQrDataUrl?: string | null; groupQrDataUrl?: string | null } | null;
    const result = await saveSystemSettings(prisma, {
      systemName: typeof body?.systemName === 'string' ? body.systemName : undefined,
      logoDataUrl: body?.logoDataUrl === undefined ? undefined : body.logoDataUrl,
      invitePromoCopy: typeof body?.invitePromoCopy === 'string' ? body.invitePromoCopy : undefined,
      invitePosterDataUrl: body?.invitePosterDataUrl === undefined ? undefined : body.invitePosterDataUrl,
      supportQrDataUrl: body?.supportQrDataUrl === undefined ? undefined : body.supportQrDataUrl,
      groupQrDataUrl: body?.groupQrDataUrl === undefined ? undefined : body.groupQrDataUrl,
    });
    void writeAdminAudit(prisma, user.id, null, 'settings.update', {
      fields: body && typeof body === 'object' ? Object.keys(body).filter((key) => !key.toLowerCase().includes('dataurl')) : [],
    });
    return { success: true, message: '基本设置已保存', ...result };
  });
}
