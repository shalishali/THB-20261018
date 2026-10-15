import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  signInitialPasswordChangeToken,
  signToken,
  TokenPurposeError,
  verifyInitialPasswordChangeToken,
} from '../auth/middleware';
import type { JwtPayload } from '../auth/middleware';
import { validateInitialPassword } from '../auth/initialPassword';
import { parseModules } from '../auth/permissions';
import { generateCaptcha, verifyCaptcha } from '../auth/captcha';
import { sendPasswordResetEmail } from '../auth/mailer';
import { createRateLimit } from '../auth/rateLimit';
import { createHash, randomBytes } from 'node:crypto';

// 公开路由（无需登录）：POST /api/login（登录）、POST /api/register（自助注册，注册即激活）、
// GET /api/captcha（图形验证码，API-02）、POST /api/forgot-password、POST /api/reset-password（邮箱找回密码，API-04/05）。
const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
// 邀请码字符集：去掉易混淆字符（0/O、1/I）
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// 重置令牌哈希：库中只存 sha256(token)，原始 token 仅出现在邮件链接里（API-05）。
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 生成全局唯一邀请码（DB-08：注册即生成，用户专属，用于邀请注册归因）。
async function generateInviteCode(prisma: PrismaClient): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    }
    const exists = await prisma.user.findUnique({ where: { inviteCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  return `YB${Date.now().toString(36).toUpperCase()}`; // 兜底：时间戳保证唯一
}

interface AuthUserSource {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  phone: string | null;
  department: string | null;
  modules: string;
}

function toAuthUser(user: AuthUserSource) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    phone: user.phone,
    department: user.department,
    modules: parseModules(user.modules),
  };
}

export async function authRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // API-11：公开认证接口按 IP 限流（图形验证码之外的第二道防线）。
  // login 10 次/10 分钟（防口令爆破）；register 5 次/10 分钟（防批量注册）；
  // forgot/reset-password 5 次/10 分钟（防重置 token 爆破 + 邮件轰炸）。
  const loginRateLimit = createRateLimit({ name: 'auth-login', windowMs: 10 * 60_000, max: 10, keyBy: 'ip' });
  const registerRateLimit = createRateLimit({ name: 'auth-register', windowMs: 10 * 60_000, max: 5, keyBy: 'ip' });
  const passwordResetRateLimit = createRateLimit({ name: 'auth-pwd-reset', windowMs: 10 * 60_000, max: 5, keyBy: 'ip' });

  // POST /login { username(手机号/admin), password, captchaId, captchaCode } → { token, user }。
  // username 列对手机号注册用户存的就是手机号；seed 的 admin 同理。
  app.post('/login', { onRequest: loginRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password, captchaId, captchaCode } = ((req.body ?? {}) as {
      username?: string;
      password?: string;
      captchaId?: string;
      captchaCode?: string;
    });
    if (!username || !password) {
      return reply.code(400).send({ error: '手机号和密码必填' });
    }
    // API-02：登录图形验证码（一次性消费，防爆破/防刷）。
    if (!verifyCaptcha(captchaId, captchaCode)) {
      return reply.code(400).send({ error: '图形验证码错误或已过期，请重新输入' });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: '手机号或密码错误' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return reply.code(401).send({ error: '手机号或密码错误' });
    }
    if (user.mustChangePassword) {
      if (user.role !== 'admin') {
        return reply.code(403).send({ error: '账号状态异常，请联系管理员' });
      }
      return {
        password_change_required: true,
        password_change_token: signInitialPasswordChangeToken({
          id: user.id,
          username: user.username,
          role: user.role,
        }),
        expires_in: 600,
      };
    }
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    return {
      token,
      user: toAuthUser(user),
    };
  });

  app.post('/change-initial-password', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ') || !header.slice(7)) {
      return reply.code(401).send({ error: '改密凭证无效或已过期，请重新登录' });
    }

    let payload: JwtPayload;
    try {
      payload = verifyInitialPasswordChangeToken(header.slice(7));
    } catch (error) {
      if (error instanceof TokenPurposeError && error.code === 'access-token-not-allowed') {
        return reply.code(403).send({ error: '该凭证不能用于初始密码修改' });
      }
      return reply.code(401).send({ error: '改密凭证无效或已过期，请重新登录' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) {
      return reply.code(401).send({ error: '账号不存在' });
    }
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '只有管理员可修改初始密码' });
    }
    if (!user.mustChangePassword) {
      return reply.code(409).send({ error: '初始密码已经修改，请使用新密码登录' });
    }

    const { newPassword, confirmPassword } = ((req.body ?? {}) as {
      newPassword?: unknown;
      confirmPassword?: unknown;
    });
    if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
      return reply.code(400).send({ error: '新密码和确认密码必填' });
    }
    if (newPassword !== confirmPassword) {
      return reply.code(400).send({ error: '两次输入的密码不一致' });
    }
    const [passwordError] = validateInitialPassword(newPassword);
    if (passwordError) {
      return reply.code(400).send({ error: passwordError });
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return reply.code(400).send({ error: '新密码不能与当前密码相同' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.user.updateMany({
      where: { id: user.id, mustChangePassword: true },
      data: { password: hashed, mustChangePassword: false },
    });
    if (updated.count === 0) {
      return reply.code(409).send({ error: '初始密码已经修改，请使用新密码登录' });
    }

    const changedUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!changedUser) {
      return reply.code(401).send({ error: '账号不存在' });
    }
    if (changedUser.role !== 'admin') {
      return reply.code(403).send({ error: '只有管理员可修改初始密码' });
    }
    return {
      token: signToken({ id: changedUser.id, username: changedUser.username, role: changedUser.role }),
      user: toAuthUser(changedUser),
    };
  });

  // GET /captcha → { captchaId, svg }。图形验证码（API-02），5 分钟有效、一次性消费。
  app.get('/captcha', async () => generateCaptcha());

  // POST /register { phone, password, displayName, department, email?, inviteCode?, captchaId, captchaCode }
  // → 建 role=user 账号（username=手机号，注册即激活可用）。
  // API-02 验证码防刷；API-06 邀请码归因：校验通过则随账号创建一并写邀请关系（首绑唯一，不可变更）；
  // DB-08 注册即为新用户生成专属邀请码。
  app.post('/register', { onRequest: registerRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone, password, displayName, department, email, inviteCode, captchaId, captchaCode } = ((req.body ?? {}) as {
      phone?: string;
      password?: string;
      displayName?: string;
      department?: string;
      email?: string;
      inviteCode?: string;
      captchaId?: string;
      captchaCode?: string;
    });
    if (!verifyCaptcha(captchaId, captchaCode)) {
      return reply.code(400).send({ error: '图形验证码错误或已过期，请重新输入' });
    }
    if (!phone || !PHONE_RE.test(phone)) {
      return reply.code(400).send({ error: '手机号格式不正确' });
    }
    if (!displayName || !displayName.trim()) {
      return reply.code(400).send({ error: '请输入姓名' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: '密码至少 8 位' });
    }
    // 邮箱选填（用于邮箱找回密码，API-04/05）：提供则校验格式与唯一性。
    const normalizedEmail = email?.trim().toLowerCase() || null;
    if (normalizedEmail && !EMAIL_RE.test(normalizedEmail)) {
      return reply.code(400).send({ error: '邮箱格式不正确' });
    }
    if (normalizedEmail) {
      const emailTaken = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
      if (emailTaken) {
        return reply.code(409).send({ error: '该邮箱已被使用' });
      }
    }
    // 邀请码选填（API-06）：提供时必须有效；归因关系在被邀请人创建时一并落库（首绑唯一）。
    const normalizedInviteCode = inviteCode?.trim().toUpperCase() || '';
    const inviter = normalizedInviteCode
      ? await prisma.user.findUnique({ where: { inviteCode: normalizedInviteCode }, select: { id: true } })
      : null;
    if (normalizedInviteCode && !inviter) {
      return reply.code(400).send({ error: '邀请码无效' });
    }
    const exists = await prisma.user.findUnique({ where: { phone } });
    if (exists) {
      return reply.code(409).send({ error: '该手机号已注册' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const userInviteCode = await generateInviteCode(prisma);
    await prisma.user.create({
      data: {
        username: phone,
        phone,
        password: hashed,
        displayName: displayName.trim(),
        department: department?.trim() || null,
        role: 'user',
        email: normalizedEmail,
        inviteCode: userInviteCode,
        ...(inviter ? { inviteRelationsAsInvitee: { create: { inviterId: inviter.id } } } : {}),
      },
    });
    return { success: true, message: '注册成功，请使用手机号登录' };
  });

  // POST /forgot-password { email } → 生成一次性重置令牌并发送邮件（API-04）。
  // 无论邮箱是否注册都返回统一成功文案（不泄露注册情况）；开发模式（MAIL_DEV_MODE，默认开）
  // 额外返回 devResetUrl 便于内网/试用闭环，SMTP 接入后移除（二期 API-29）。
  app.post('/forgot-password', { onRequest: passwordResetRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { email } = ((req.body ?? {}) as { email?: string });
    const normalized = email?.trim().toLowerCase() || '';
    if (!normalized || !EMAIL_RE.test(normalized)) {
      return reply.code(400).send({ error: '请输入有效的邮箱地址' });
    }
    const genericMessage = '如果该邮箱已注册，重置链接已发送，请在 30 分钟内完成重置';
    const user = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });
    if (!user) {
      return { success: true, message: genericMessage };
    }
    const rawToken = randomBytes(32).toString('base64url');
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: hashResetToken(rawToken), resetExpire: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    });
    const webBase = (process.env.WEB_BASE_URL?.trim() || `http://${req.hostname}`).replace(/\/+$/, '');
    const resetUrl = `${webBase}/reset-password?token=${rawToken}`;
    const mail = await sendPasswordResetEmail(normalized, resetUrl);
    const payload: Record<string, unknown> = { success: true, message: genericMessage };
    if (mail.devMode) {
      payload.devResetUrl = resetUrl;
    }
    return payload;
  });

  // POST /reset-password { token, newPassword, confirmPassword } → 校验令牌有效期并重置密码（API-05）。
  // 令牌一次性：成功或过期均清空 resetToken/resetExpire。
  app.post('/reset-password', { onRequest: passwordResetRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { token, newPassword, confirmPassword } = ((req.body ?? {}) as {
      token?: string;
      newPassword?: string;
      confirmPassword?: string;
    });
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: '重置链接无效' });
    }
    if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string' || !newPassword || !confirmPassword) {
      return reply.code(400).send({ error: '新密码和确认密码必填' });
    }
    if (newPassword !== confirmPassword) {
      return reply.code(400).send({ error: '两次输入的密码不一致' });
    }
    if (newPassword.length < 8) {
      return reply.code(400).send({ error: '密码至少 8 位' });
    }
    const user = await prisma.user.findUnique({ where: { resetToken: hashResetToken(token) } });
    if (!user) {
      return reply.code(400).send({ error: '重置链接无效或已被使用，请重新申请' });
    }
    if (!user.resetExpire || user.resetExpire.getTime() <= Date.now()) {
      await prisma.user.update({ where: { id: user.id }, data: { resetToken: null, resetExpire: null } });
      return reply.code(400).send({ error: '重置链接已过期，请重新申请' });
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return reply.code(400).send({ error: '新密码不能与当前密码相同' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, resetToken: null, resetExpire: null },
    });
    return { success: true, message: '密码重置成功，请使用新密码登录' };
  });
}

// 受保护路由（需登录）：GET /api/me → 返回当前用户最新信息（权限即时生效的拉取端点）。
// 挂在 protectedApp 块（verifyToken 已注入 req.user），不进公开 authRoutes。
// 返回形状与 /login 的 user 完全一致；账号不存在 → 401（前端据此 logout）。
export async function meRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = (req as FastifyRequest & { user: JwtPayload }).user;
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) {
      return reply.code(401).send({ error: '账号不存在' });
    }
    return {
      user: toAuthUser(user),
    };
  });
}
