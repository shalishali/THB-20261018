import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { meRoutes } = await import('./auth');

async function buildApp() {
  const row = {
    id: 7,
    username: '13800000000',
    password: await bcrypt.hash('old-password-123', 10),
  };
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: { id: number } }).user = { id: row.id };
  });
  app.decorate('prisma', {
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => (
        where.id === row.id ? { ...row, role: 'user' } : null
      ),
      update: async ({ where, data }: { where: { id: number }; data: { password: string } }) => {
        if (where.id !== row.id) throw new Error('unexpected id');
        row.password = data.password;
        return { ...row };
      },
    },
  });
  await app.register(meRoutes, { prefix: '/api' });
  return { app, row };
}

test('登录后可设置密码且不回显明文', async (t) => {
  const { app, row } = await buildApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/me/password',
    payload: { newPassword: 'new-password-123', confirmPassword: 'new-password-123' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().success, true);
  assert.equal(await bcrypt.compare('new-password-123', row.password), true);
});

test('两次密码不一致时拒绝设置', async (t) => {
  const { app, row } = await buildApp();
  t.after(() => app.close());
  const before = row.password;
  const response = await app.inject({
    method: 'POST',
    url: '/api/me/password',
    payload: { newPassword: 'new-password-123', confirmPassword: 'new-password-456' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /不一致/);
  assert.equal(row.password, before);
});

test('密码少于 8 位或与当前密码相同均拒绝', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const shortResponse = await app.inject({
    method: 'POST',
    url: '/api/me/password',
    payload: { newPassword: 'short', confirmPassword: 'short' },
  });
  assert.equal(shortResponse.statusCode, 400);
  assert.match(shortResponse.json().error, /至少 8 位/);

  const sameResponse = await app.inject({
    method: 'POST',
    url: '/api/me/password',
    payload: { newPassword: 'old-password-123', confirmPassword: 'old-password-123' },
  });
  assert.equal(sameResponse.statusCode, 400);
  assert.match(sameResponse.json().error, /不能与当前密码相同/);
});
