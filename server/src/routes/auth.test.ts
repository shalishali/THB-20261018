import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
// 本地 .env 可能设置 ALLOW_PASSWORD_LOGIN=1（联调通道）；单测必须验证生产语义（手机号账号禁止密码登录），
// 因此这里强制关闭该开关（dotenv 不覆盖已存在的 env）。
process.env.ALLOW_PASSWORD_LOGIN = '0';
const { authRoutes } = await import('./auth');
const { signInitialPasswordChangeToken, signToken } = await import('../auth/middleware');
const { generateCaptcha, __getCaptchaAnswerForTest } = await import('../auth/captcha');

// API-02 后登录必须带图形验证码。验证码明文按序渲染在 SVG <text> 节点里，测试按序提取。
function solvedCaptcha(): { captchaId: string; captchaCode: string } {
  const { captchaId } = generateCaptcha();
  return { captchaId, captchaCode: __getCaptchaAnswerForTest(captchaId) || '' };
}

interface UserRow {
  id: number;
  username: string;
  password: string;
  displayName: string | null;
  role: string;
  phone: string | null;
  department: string | null;
  modules: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function makeUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  return {
    id: 1,
    username: 'admin',
    password: await bcrypt.hash('admin', 10),
    displayName: '管理员',
    role: 'admin',
    phone: null,
    department: null,
    modules: '[]',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildApp(initial: UserRow) {
  let row = { ...initial };
  const app = Fastify();
  app.decorate('prisma', {
    user: {
      findUnique: async ({ where }: { where: { id?: number; username?: string } }) => {
        if (where.id != null && where.id !== row.id) return null;
        if (where.username != null && where.username !== row.username) return null;
        return { ...row };
      },
      updateMany: async ({ where, data }: {
        where: { id: number; mustChangePassword: boolean };
        data: Partial<UserRow>;
      }) => {
        if (where.id !== row.id || row.mustChangePassword !== where.mustChangePassword) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
      create: async () => { throw new Error('not used'); },
    },
  });
  await app.register(authRoutes, { prefix: '/api' });
  return { app, readUser: () => ({ ...row }) };
}

test('默认管理员登录只返回改密令牌', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'admin', captchaId, captchaCode },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().password_change_required, true);
  assert.equal(response.json().expires_in, 600);
  assert.equal('token' in response.json(), false);
});

test('弱密码和确认不一致均不能完成初始改密', async (t) => {
  const user = await makeUser();
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'weak-password', confirmPassword: 'weak-password' },
  });
  assert.equal(response.statusCode, 400);
  const mismatch = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass2!' },
  });
  assert.equal(mismatch.statusCode, 400);
});

test('默认密码和当前密码不能作为新密码', async (t) => {
  const currentPassword = 'Already-Strong1!';
  const user = await makeUser({ password: await bcrypt.hash(currentPassword, 10) });
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const defaultReuse = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'admin', confirmPassword: 'admin' },
  });
  assert.equal(defaultReuse.statusCode, 400);
  const currentReuse = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: currentPassword, confirmPassword: currentPassword },
  });
  assert.equal(currentReuse.statusCode, 400);
});

test('普通用户登录行为保持不变', async (t) => {
  const password = 'User-Pass1!';
  const user = await makeUser({
    username: '13800000000',
    password: await bcrypt.hash(password, 10),
    role: 'user',
    mustChangePassword: false,
  });
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: user.username, password, captchaId, captchaCode },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().token, 'string');
  assert.equal(response.json().user.username, user.username);
});

test('强密码修改成功并直接返回正式令牌且不能重放', async (t) => {
  const user = await makeUser();
  const { app, readUser } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass1!' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().token, 'string');
  assert.equal(response.json().user.username, 'admin');
  const updated = readUser();
  assert.equal(updated.mustChangePassword, false);
  assert.equal(await bcrypt.compare('Strong-Pass1!', updated.password), true);
  const replay = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Another-Pass2!', confirmPassword: 'Another-Pass2!' },
  });
  assert.equal(replay.statusCode, 409);
});

// 注册界面精简（不再收集姓名/部门/邮箱）：仅手机号+密码+图形验证码（+选填邀请码）。
interface RegisterCreatedUser {
  displayName: string | null;
  department: string | null;
  email: string | null;
  inviteCode: string;
  inviteRelationsAsInvitee?: { create: { inviterId: number } };
}

async function buildRegisterApp(existing: Array<{ id: number; phone?: string | null; inviteCode?: string | null }> = []) {
  const created: RegisterCreatedUser[] = [];
  const app = Fastify();
  app.decorate('prisma', {
    user: {
      findUnique: async ({ where }: { where: { phone?: string; email?: string; inviteCode?: string } }) => {
        if (where.email != null) return null;
        if (where.phone != null) return existing.find((u) => u.phone === where.phone) ?? null;
        return existing.find((u) => u.inviteCode === where.inviteCode) ?? null;
      },
      create: async ({ data }: { data: RegisterCreatedUser }) => {
        created.push(data);
        return { id: 100, ...data };
      },
    },
  });
  await app.register(authRoutes, { prefix: '/api' });
  return { app, created };
}

test('自助注册接口已下线（410），改走短信验证码登录', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { phone: '13800001111', password: 'User-Pass1!' },
  });
  assert.equal(response.statusCode, 410);
  assert.match(response.json().error, /验证码/);
});

test('邮箱找回密码相关接口已下线（410）', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  for (const url of ['/api/forgot-password', '/api/reset-password']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 410);
  }
});

test('有效正式访问令牌用于初始改密时返回 403', async (t) => {
  const user = await makeUser();
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: {
      authorization: `Bearer ${signToken({ id: user.id, username: user.username, role: user.role })}`,
    },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass1!' },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, '该凭证不能用于初始密码修改');
});

test('无效、过期或未知用途的令牌用于初始改密时返回 401', async (t) => {
  const user = await makeUser();
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const tokens = [
    'not-a-jwt',
    jwt.sign(
      { id: user.id, username: user.username, role: user.role, purpose: 'initial-password-change' },
      process.env.JWT_SECRET as string,
      { expiresIn: -1 },
    ),
    jwt.sign(
      { id: user.id, username: user.username, role: user.role, purpose: 'service-token' },
      process.env.JWT_SECRET as string,
      { expiresIn: '10m' },
    ),
  ];

  for (const token of tokens) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/change-initial-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass1!' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, '改密凭证无效或已过期，请重新登录');
  }
});

// ===== 登录即注册（autoRegister）=====

interface AutoRegisterCreated {
  username: string;
  phone: string;
  password: string;
  role: string;
  inviteCode: string;
  registerIp: string;
  registerUserAgent: string;
  [key: string]: unknown;
}

async function buildAutoRegisterApp(existing: UserRow) {
  const row = { ...existing };
  const created: AutoRegisterCreated[] = [];
  const app = Fastify();
  app.decorate('prisma', {
    user: {
      findUnique: async ({ where }: { where: { id?: number; username?: string; phone?: string; inviteCode?: string } }) => {
        if (where.id != null) return row.id === where.id ? { ...row } : null;
        if (where.username != null) return row.username === where.username ? { ...row } : null;
        if (where.phone != null) return row.phone === where.phone ? { ...row } : null;
        if (where.inviteCode != null) return null;
        return { ...row };
      },
      create: async ({ data }: { data: AutoRegisterCreated }) => {
        const createdRow = {
          id: 200,
          tokenVersion: 0,
          mustChangePassword: false,
          displayName: null,
          department: null,
          modules: '[]',
          quotaChars: 0,
          quotaUsedChars: 0,
          ...data,
        };
        created.push(createdRow);
        return createdRow;
      },
    },
  });
  await app.register(authRoutes, { prefix: '/api' });
  return { app, created };
}

test('手机号账号禁止密码登录，必须走短信验证码', async (t) => {
  const { app } = await buildApp(await makeUser({
    username: '13800000000',
    role: 'user',
    mustChangePassword: false,
    phone: '13800000000',
  }));
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: {
      username: '13800000000',
      password: 'Whatever-Pass1!',
      captchaId,
      captchaCode,
    },
  });
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /验证码登录/);
});

test('管理员绑定手机号后仍可用密码登录（break-glass）', async (t) => {
  const { app } = await buildApp(await makeUser({
    username: 'admin',
    role: 'admin',
    mustChangePassword: false,
    phone: '17341418824',
  }));
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: {
      username: 'admin',
      password: 'admin',
      captchaId,
      captchaCode,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().token, 'string');
});

test('短信发送不再要求图形验证码（直接校验手机号）', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/sms/send',
    payload: { phone: 'bad-phone', purpose: 'login' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /手机号/);
  assert.doesNotMatch(response.json().error, /图形验证码/);
});

test('登录即注册：非手机号账号名永不自动建号（保持 401 原语义）', async (t) => {
  const { app, created } = await buildAutoRegisterApp(await makeUser());
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: {
      username: 'root',
      password: 'whatever-pass',
      captchaId,
      captchaCode,
      autoRegister: true,
      agree: true,
    },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(created.length, 0);
});

test('验证码登录缺少 6 位验证码时返回 400', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/login-sms',
    payload: { phone: '13800001111', code: 'abc' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /6 位/);
});

test('登录即注册：不携带 autoRegister 时保持原 401 行为', async (t) => {
  const { app, created } = await buildAutoRegisterApp(await makeUser({
    username: '13800000000',
    role: 'user',
    mustChangePassword: false,
    phone: '13800000000',
  }));
  t.after(() => app.close());
  const { captchaId, captchaCode } = solvedCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: {
      username: '13900001234',
      password: 'Whatever-Pass1!',
      captchaId,
      captchaCode,
    },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(created.length, 0);
});
