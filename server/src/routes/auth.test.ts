import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { authRoutes } = await import('./auth');
const { signInitialPasswordChangeToken, signToken } = await import('../auth/middleware');
const { generateCaptcha } = await import('../auth/captcha');

// API-02 后登录必须带图形验证码。验证码明文按序渲染在 SVG <text> 节点里，测试按序提取。
function extractCaptchaCode(svg: string): string {
  return [...svg.matchAll(/<text[^>]*>([A-Z2-9])<\/text>/g)].map((m) => m[1]).join('');
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
  const { captchaId, svg } = generateCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'admin', captchaId, captchaCode: extractCaptchaCode(svg) },
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
  const { captchaId, svg } = generateCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: user.username, password, captchaId, captchaCode: extractCaptchaCode(svg) },
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

test('注册不再收集姓名：仅手机号+密码+验证码即可成功且姓名/部门/邮箱落空', async (t) => {
  const { app, created } = await buildRegisterApp();
  t.after(() => app.close());
  const { captchaId, svg } = generateCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { phone: '13800001111', password: 'User-Pass1!', captchaId, captchaCode: extractCaptchaCode(svg) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].displayName, null);
  assert.equal(created[0].department, null);
  assert.equal(created[0].email, null);
  assert.match(created[0].inviteCode, /^[A-Z2-9]{8}$|^YB/);
  assert.equal('inviteRelationsAsInvitee' in created[0], false);
});

test('注册携带邀请码建立归因关系（无需姓名，码大小写归一化）', async (t) => {
  const { app, created } = await buildRegisterApp([{ id: 99, phone: '13800000000', inviteCode: 'INVITER1' }]);
  t.after(() => app.close());
  const { captchaId, svg } = generateCaptcha();
  const response = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { phone: '13800002222', password: 'User-Pass1!', inviteCode: 'inviter1', captchaId, captchaCode: extractCaptchaCode(svg) },
  });
  assert.equal(response.statusCode, 200);
  // DB-22：邀请关系同时落注册 IP / UA（反作弊采集），此处只断言归因关系与 IP 已采集
  const relation = (created[0].inviteRelationsAsInvitee as { create: { inviterId: number; registerIp?: string } }).create;
  assert.equal(relation.inviterId, 99);
  assert.ok(typeof relation.registerIp === 'string' && relation.registerIp.length > 0);
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
