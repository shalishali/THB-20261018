import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { aiRoutes } = await import('./ai');

// AI 代理接口的安全边界：chat / request-json 只服务于管理员设置页的连通性测试，
// 任务生成链路走 tasks/service 内部 aiService，不经过 HTTP 代理。
async function buildApp(user: { id: number; role: string } | null) {
  const app = Fastify();
  app.decorate('prisma', {});
  app.addHook('onRequest', async (req) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
  });
  await app.register(aiRoutes, { prefix: '/api' });
  return app;
}

test('AI 代理：普通用户调用 chat 返回 403', async (t) => {
  const app = await buildApp({ id: 7, role: 'user' });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /仅管理员/);
});

test('AI 代理：普通用户调用 request-json 返回 403', async (t) => {
  const app = await buildApp({ id: 7, role: 'user' });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/request-json',
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 403);
});

test('AI 代理：普通用户拉取模型列表返回 403', async (t) => {
  const app = await buildApp({ id: 7, role: 'user' });
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/api/ai/list-models', payload: {} });
  assert.equal(res.statusCode, 403);
});

test('AI 代理：没有登录态同样返回 403', async (t) => {
  const app = await buildApp(null);
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 403);
});
