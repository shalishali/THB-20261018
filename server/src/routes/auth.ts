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
import { generateCaptcha, verifyCaptcha, __getCaptchaAnswerForTest } from '../auth/captcha';
import { getSignupGrantChars } from '../quota/service';
import { createRateLimit } from '../auth/rateLimit';
import { clientIp } from '../auth/rateLimit';
import {
  SMS_CODE_TTL_MS,
  SMS_DAILY_LIMIT_PER_PHONE,
  SMS_MAX_ATTEMPTS,
  SMS_RESEND_INTERVAL_MS,
  generateSmsCode,
  hashSmsCode,
  isSmsConfigured,
  sendSmsCode,
  type SmsPurpose,
} from '../auth/sms';
import { trackActivity } from '../analytics/service';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// 公开路由（无需登录）：
// - POST /api/sms/send            发送短信验证码（登录/重置共用，必须先过图形验证码）
// - POST /api/login-sms           手机号 + 短信验证码登录（未注册且已同意协议时自动建号）
// - POST /api/reset-password-sms  手机号 + 短信验证码重置密码
// - POST /api/login               仅限无手机号的遗留账号（初始管理员 admin）使用密码登录
// - GET  /api/captcha             图形验证码（短信发送前的人机校验）
// 原「注册」「邮箱找回密码」接口已下线（410），统一走短信。
const PHONE_RE = /^1[3-9]\d{9}$/;
// 邀请码字符集：去掉易混淆字符（0/O、1/I）
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SMS_CODE_RE = /^\d{6}$/;

function isSmsPurpose(value: unknown): value is SmsPurpose {
  return value === 'login' || value === 'reset';
}

// 生成全局唯一邀请码（DB-08：注册即生成，用户专属，用于邀请注册归因）。
// 导出供 invite 路由复用（API-14：存量无码用户首次获取邀请码时补生成，逻辑同源）。
export async function generateInviteCode(prisma: PrismaClient): Promise<string> {
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
  quotaChars: number;
  quotaUsedChars: number;
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
    quotaChars: user.quotaChars,
    quotaUsedChars: user.quotaUsedChars,
  };
}

export async function authRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // API-11：公开认证接口按 IP 限流（图形验证码之外的第二道防线）。
  // 短信发送额外叠加「同号 60s 冷却 + 每号每日上限」，防短信轰炸与费用攻击。
  const loginRateLimit = createRateLimit({ name: 'auth-login', windowMs: 10 * 60_000, max: 10, keyBy: 'ip' });
  const smsSendRateLimit = createRateLimit({ name: 'auth-sms-send', windowMs: 10 * 60_000, max: 10, keyBy: 'ip' });
  const smsLoginRateLimit = createRateLimit({ name: 'auth-sms-login', windowMs: 10 * 60_000, max: 20, keyBy: 'ip' });
  const smsResetRateLimit = createRateLimit({ name: 'auth-sms-reset', windowMs: 10 * 60_000, max: 10, keyBy: 'ip' });
  const captchaRateLimit = createRateLimit({ name: 'auth-captcha', windowMs: 60_000, max: 30, keyBy: 'ip' });

  // 校验并消费短信验证码：一次性、限次、定时过期。
  async function consumeSmsCode(
    phone: string,
    purpose: SmsPurpose,
    code: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const row = await prisma.smsCode.findFirst({
      where: { phone, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true },
    });
    if (!row) return { ok: false, status: 400, error: '验证码已失效，请重新获取' };
    // 原子抢占一次尝试：并发请求会同时读到旧 attempts 并通过上限检查（读-比-写竞态），
    // 先无条件 increment 再按 count 判断，才能保证「最多 5 次」在并发下不被放大。
    const claimed = await prisma.smsCode.updateMany({
      where: { id: row.id, usedAt: null, attempts: { lt: SMS_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      return { ok: false, status: 429, error: '验证码尝试次数过多，请重新获取' };
    }
    const expected = Buffer.from(hashSmsCode(phone, purpose, code), 'hex');
    const actual = Buffer.from(row.codeHash, 'hex');
    const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matched) {
      return { ok: false, status: 400, error: '验证码错误' };
    }
    await prisma.smsCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return { ok: true };
  }

  // POST /login { username, password, captchaId, captchaCode } → { token, user }。
  // 仅限「没有手机号的遗留账号」（初始管理员 admin）使用密码登录；手机号账号一律走 /login-sms。
  // 这样既保证管理员在未绑定手机号时仍能进后台，又不给普通用户留一条可爆破的密码通道。
  app.post('/login', { onRequest: loginRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password, captchaId, captchaCode } = ((req.body ?? {}) as {
      username?: string;
      password?: string;
      captchaId?: string;
      captchaCode?: string;
    });
    if (!username || !password) {
      return reply.code(400).send({ error: '账号和密码必填' });
    }
    // API-02：图形验证码（一次性消费，防爆破/防刷）。
    if (!verifyCaptcha(captchaId, captchaCode)) {
      return reply.code(400).send({ error: '图形验证码错误或已过期，请重新输入' });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: '账号或密码错误' });
    }
    // 手机号账号强制短信登录：即使密码泄露也无法绕过短信直接登录。
    // 管理员例外（break-glass）：短信服务未配置/故障时，唯一管理员仍可通过强密码 + 图形验证码
    // 进入后台，避免把运维锁在门外。管理员密码受 12 位复杂度策略 + 验证码 + IP 限流保护。
    // 联调开关：非生产环境显式设置 ALLOW_PASSWORD_LOGIN=1 时，普通手机号账号也可用密码登录
    // （短信服务未接入前的测试通道）。NODE_ENV=production 时该变量永远不生效。
    const allowPasswordForPhoneUsers = process.env.NODE_ENV !== 'production' && process.env.ALLOW_PASSWORD_LOGIN === '1';
    if (user.phone && user.role !== 'admin' && !allowPasswordForPhoneUsers) {
      return reply.code(403).send({ error: '该账号已启用短信验证码登录，请使用手机号获取验证码登录' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return reply.code(401).send({ error: '账号或密码错误' });
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
    void trackActivity(prisma, user.id, 'login', undefined, clientIp(req));
    const token = signToken({ id: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion });
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
      // H1：初始改密成功即 +1 tokenVersion，作废此前签发的一切旧令牌
      data: { password: hashed, mustChangePassword: false, tokenVersion: { increment: 1 } },
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
      token: signToken({ id: changedUser.id, username: changedUser.username, role: changedUser.role, tokenVersion: changedUser.tokenVersion }),
      user: toAuthUser(changedUser),
    };
  });

  // GET /captcha → { captchaId, image }。图形验证码（API-02），5 分钟有效、一次性消费。
  // image 是 PNG data URL：答案只存在于服务端内存，响应体里不含任何可解析的字符。
  // M5：匿名接口挂 IP 限流，防验证码接口被刷（生成消耗 CPU + 内存条目）。
  app.get('/captcha', { onRequest: captchaRateLimit }, async () => {
    const challenge = generateCaptcha();
    // E2E 专用旁路：仅非生产 + 显式开关时回显答案，避免自动化测试去 OCR 位图。
    // 生产环境即使误设该变量也永远不生效（NODE_ENV 守卫在前）。
    if (process.env.NODE_ENV !== 'production' && process.env.E2E_CAPTCHA_BYPASS === '1') {
      return { ...challenge, devCode: __getCaptchaAnswerForTest(challenge.captchaId) };
    }
    return challenge;
  });

  // ---- 短信验证码登录 / 重置 ----

  // POST /sms/send { phone, purpose:'login'|'reset', captchaId, captchaCode }
  // 必须先过图形验证码：否则这个接口就是别人刷你短信费的入口。
  app.post('/sms/send', { onRequest: smsSendRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone, purpose, captchaId, captchaCode } = ((req.body ?? {}) as {
      phone?: string;
      purpose?: string;
      captchaId?: string;
      captchaCode?: string;
    });
    if (!verifyCaptcha(captchaId, captchaCode)) {
      return reply.code(400).send({ error: '图形验证码错误或已过期，请重新输入' });
    }
    const target = String(phone || '').trim();
    if (!PHONE_RE.test(target)) {
      return reply.code(400).send({ error: '请输入有效的 11 位手机号' });
    }
    if (!isSmsPurpose(purpose)) {
      return reply.code(400).send({ error: '验证码用途不合法' });
    }
    if (!isSmsConfigured()) {
      return reply.code(503).send({ error: '短信服务尚未配置，请联系客服' });
    }
    const now = Date.now();
    // 同号 60s 冷却（不区分用途，避免"登录/重置"两边轮流发绕过冷却）
    const recent = await prisma.smsCode.findFirst({
      where: { phone: target },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent) {
      const elapsed = now - recent.createdAt.getTime();
      if (elapsed < SMS_RESEND_INTERVAL_MS) {
        const wait = Math.max(1, Math.ceil((SMS_RESEND_INTERVAL_MS - elapsed) / 1000));
        return reply.code(429).send({ error: `发送过于频繁，请 ${wait} 秒后再试`, retryAfterSeconds: wait });
      }
    }
    const sentToday = await prisma.smsCode.count({
      where: { phone: target, createdAt: { gte: new Date(now - 24 * 3600 * 1000) } },
    });
    if (sentToday >= SMS_DAILY_LIMIT_PER_PHONE) {
      return reply.code(429).send({ error: '该手机号今日验证码发送次数已达上限，请明天再试或联系客服' });
    }
    const code = generateSmsCode();
    const row = await prisma.smsCode.create({
      data: {
        phone: target,
        purpose,
        codeHash: hashSmsCode(target, purpose, code),
        expiresAt: new Date(now + SMS_CODE_TTL_MS),
        ip: clientIp(req),
      },
      select: { id: true },
    });
    // 顺手清理一天前的过期记录，避免表无限增长（best-effort）
    void prisma.smsCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 24 * 3600 * 1000) } } }).catch(() => undefined);
    try {
      const result = await sendSmsCode(target, code);
      return {
        success: true,
        ttlSeconds: Math.round(SMS_CODE_TTL_MS / 1000),
        provider: result.provider,
        ...(result.devCode ? { devCode: result.devCode } : {}),
      };
    } catch (error) {
      req.log.error({ err: error }, 'sms send failed');
      // 发送失败就删掉这条码，避免用户"收不到但已占额度/冷却"
      void prisma.smsCode.delete({ where: { id: row.id } }).catch(() => undefined);
      return reply.code(502).send({ error: '短信发送失败，请稍后重试或联系客服' });
    }
  });

  // POST /login-sms { phone, code, agree?, inviteCode? } → { token, user, created? }
  // 未注册手机号：agree=true 时自动建号（短信已验证手机号真实性），inviteCode 选填用于归因。
  app.post('/login-sms', { onRequest: smsLoginRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone, code, agree, inviteCode } = ((req.body ?? {}) as {
      phone?: string;
      code?: string;
      agree?: boolean;
      inviteCode?: string;
    });
    const target = String(phone || '').trim();
    if (!PHONE_RE.test(target)) {
      return reply.code(400).send({ error: '请输入有效的 11 位手机号' });
    }
    const normalizedCode = typeof code === 'string' ? code.trim() : '';
    if (!SMS_CODE_RE.test(normalizedCode)) {
      return reply.code(400).send({ error: '请输入 6 位数字验证码' });
    }
    // 先查用户：新用户必须先同意协议，再消费验证码（否则忘勾协议会白烧一个码 + 60 秒冷却）。
    // 只按 phone 查：绝不能让「username 恰好等于该手机号」的账号被短信验证码登录/接管
    // （存量手工账号可能 username 是手机号但 phone 不同）。
    const existing = await prisma.user.findFirst({ where: { phone: target } });
    if (!existing && agree !== true) {
      return reply.code(400).send({ error: '首次登录请勾选同意《用户协议》与《隐私政策》', needAgree: true });
    }

    const verified = await consumeSmsCode(target, 'login', normalizedCode);
    if (!verified.ok) {
      return reply.code(verified.status).send({ error: verified.error });
    }

    if (existing) {
      if (existing.mustChangePassword) {
        if (existing.role !== 'admin') {
          return reply.code(403).send({ error: '账号状态异常，请联系管理员' });
        }
        return {
          password_change_required: true,
          password_change_token: signInitialPasswordChangeToken({
            id: existing.id,
            username: existing.username,
            role: existing.role,
          }),
          expires_in: 600,
        };
      }
      void trackActivity(prisma, existing.id, 'login', { via: 'sms' }, clientIp(req));
      return {
        token: signToken({ id: existing.id, username: existing.username, role: existing.role, tokenVersion: existing.tokenVersion }),
        user: toAuthUser(existing),
      };
    }

    const normalizedInviteCode = typeof inviteCode === 'string' ? inviteCode.trim().toUpperCase() : '';
    const inviter = normalizedInviteCode
      ? await prisma.user.findUnique({ where: { inviteCode: normalizedInviteCode }, select: { id: true } })
      : null;
    if (normalizedInviteCode && !inviter) {
      return reply.code(400).send({ error: '邀请码无效' });
    }
    // 短信登录用户没有可用密码：写入随机口令，彻底堵死密码通道
    const randomPassword = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    const registerIp = clientIp(req);
    const registerUserAgent = String(req.headers['user-agent'] || '').slice(0, 300);
    try {
      const created = await prisma.user.create({
        data: {
          username: target,
          phone: target,
          password: randomPassword,
          role: 'user',
          quotaChars: await getSignupGrantChars(prisma),
          inviteCode: await generateInviteCode(prisma),
          registerIp,
          registerUserAgent,
          ...(inviter
            ? { inviteRelationsAsInvitee: { create: { inviterId: inviter.id, registerIp, deviceFingerprint: registerUserAgent.slice(0, 120) } } }
            : {}),
        },
      });
      void trackActivity(prisma, created.id, 'register', { smsLogin: true, inviter: Boolean(inviter) }, registerIp);
      void trackActivity(prisma, created.id, 'login', { via: 'sms' }, registerIp);
      return {
        created: true,
        token: signToken({ id: created.id, username: created.username, role: created.role, tokenVersion: created.tokenVersion }),
        user: toAuthUser(created),
      };
    } catch (error) {
      // 并发首登：另一个请求已经建号，直接按已存在账号登录
      if ((error as { code?: string })?.code === 'P2002') {
        const raced = await prisma.user.findFirst({ where: { phone: target } });
        if (raced) {
          return {
            token: signToken({ id: raced.id, username: raced.username, role: raced.role, tokenVersion: raced.tokenVersion }),
            user: toAuthUser(raced),
          };
        }
      }
      throw error;
    }
  });

  // POST /reset-password-sms { phone, code, newPassword, confirmPassword }
  // 短信验证码重置密码：成功后 tokenVersion+1，吊销该账号所有旧会话。
  app.post('/reset-password-sms', { onRequest: smsResetRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone, code, newPassword, confirmPassword } = ((req.body ?? {}) as {
      phone?: string;
      code?: string;
      newPassword?: string;
      confirmPassword?: string;
    });
    const target = String(phone || '').trim();
    if (!PHONE_RE.test(target)) {
      return reply.code(400).send({ error: '请输入有效的 11 位手机号' });
    }
    const normalizedCode = typeof code === 'string' ? code.trim() : '';
    if (!SMS_CODE_RE.test(normalizedCode)) {
      return reply.code(400).send({ error: '请输入 6 位数字验证码' });
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
    const verified = await consumeSmsCode(target, 'reset', normalizedCode);
    if (!verified.ok) {
      return reply.code(verified.status).send({ error: verified.error });
    }
    // 同 /login-sms：只按 phone 定位账号，username 不参与短信重置（防手机号同名账号被接管）。
    const user = await prisma.user.findFirst({ where: { phone: target } });
    if (!user) {
      // 能收到验证码 -> 手机号真实；提示未注册不构成枚举风险
      return reply.code(400).send({ error: '该手机号尚未注册' });
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return reply.code(400).send({ error: '新密码不能与当前密码相同' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, resetToken: null, resetExpire: null, tokenVersion: { increment: 1 } },
    });
    return { success: true, message: '密码已重置，请使用手机号验证码登录' };
  });

  // 原自助注册接口已下线：注册并入「手机号 + 短信验证码登录」（未注册自动建号）。
  app.post('/register', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(410).send({ error: '注册已改为手机号验证码登录：在登录页输入手机号获取验证码即可自动创建账号' }),
  );

  // 原邮箱找回密码接口已下线：改走 /sms/send(purpose=reset) + /reset-password-sms。
  app.post('/forgot-password', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(410).send({ error: '找回密码已改为手机号验证码：请使用「忘记密码」获取短信验证码' }),
  );
  app.post('/reset-password', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(410).send({ error: '该方式已下线，请使用手机号短信验证码重置密码' }),
  );
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
