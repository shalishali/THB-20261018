import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { statsRoutes } = await import('./stats');
const { createVerifyToken, signToken } = await import('../auth/middleware');

interface StatRow {
  id: number;
  userId: number;
  projectId: number | null;
  provider: string;
  model: string;
  bizType: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  inputChars: number;
  outputChars: number;
  createdAt: Date;
}

function makeRow(overrides: Partial<StatRow> = {}): StatRow {
  return {
    id: 1,
    userId: 1,
    projectId: 1,
    provider: 'deepseek',
    model: 'deepseek-chat',
    bizType: 'generate',
    callCount: 1,
    inputTokens: 100,
    outputTokens: 200,
    inputChars: 1000,
    outputChars: 2000,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildApp(rows: StatRow[]) {
  const queries: Array<{ where: unknown; orderBy: unknown }> = [];
  const app = Fastify();
  const prismaStub = {
    // H1 加固后 verifyToken 回查库：补 user 桩（tokenVersion=0 与测试令牌匹配）
    user: {
      findUnique: async (args: { where: { id: number } }) => ({
        id: args.where.id,
        username: `user-${args.where.id}`,
        role: 'user',
        tokenVersion: 0,
      }),
    },
    aiCallStat: {
      findMany: async (args: { where: unknown; orderBy: unknown }) => {
        queries.push(args);
        return rows.filter((row) => row.userId === (args.where as { userId: number }).userId);
      },
    },
  };
  app.decorate('prisma', prismaStub);
  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', createVerifyToken(prismaStub as never));
    await protectedApp.register(statsRoutes, { prefix: '/api' });
  });
  return { app, queries };
}

test('stats/ai-usage 鏈櫥褰曡繑鍥?401', async (t) => {
  const { app } = await buildApp([]);
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/stats/ai-usage' });
  assert.equal(response.statusCode, 401);
});

test('stats/ai-usage 杩斿洖鏈汉姹囨€?鍒嗙粍/鍒嗛〉鏄庣粏锛屼笖鏌ヨ鎸?userId 杩囨护', async (t) => {
  const mine = [
    makeRow({ id: 1, userId: 7, bizType: 'generate', callCount: 2, inputTokens: 10, outputTokens: 20, inputChars: 100, outputChars: 200 }),
    makeRow({ id: 2, userId: 7, bizType: 'analyze', callCount: 1, inputTokens: 1, outputTokens: 2, inputChars: 10, outputChars: 20 }),
  ] as StatRow[];
  const { app, queries } = await buildApp(mine);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: '/api/stats/ai-usage?days=30&page=1&pageSize=10',
    headers: { authorization: `Bearer ${signToken({ id: 7, username: 'tester', role: 'user' })}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.totals.calls, 3);
  assert.equal(body.totals.inputTokens, 11);
  assert.equal(body.totals.outputTokens, 22);
  assert.equal(body.totals.inputChars, 110);
  assert.equal(body.totals.outputChars, 220);
  assert.equal(body.byBizType.generate.calls, 2);
  assert.equal(body.byBizType.analyze.calls, 1);
  assert.equal(body.items.length, 2);
  assert.equal(body.totalRows, 2);
  // API-08锛氭煡璇㈠繀椤绘寜鏈汉 userId 杩囨护銆?
  assert.equal(queries.length, 1);
  assert.deepEqual((queries[0].where as { userId: number }), { userId: 7, createdAt: { gte: (queries[0].where as { createdAt: { gte: Date } }).createdAt.gte } });
  assert.equal(typeof (queries[0].where as { createdAt: { gte: Date } }).createdAt.gte.getTime(), 'number');
});

test('stats/ai-usage 鍒嗛〉鍒囩墖鐢熸晥', async (t) => {
  const mine = [
    makeRow({ id: 1, userId: 7 }),
    makeRow({ id: 2, userId: 7 }),
    makeRow({ id: 3, userId: 7 }),
  ] as StatRow[];
  const { app } = await buildApp(mine);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: '/api/stats/ai-usage?page=2&pageSize=2',
    headers: { authorization: `Bearer ${signToken({ id: 7, username: 'tester', role: 'user' })}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.totalRows, 3);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, 3);
});

test('stats/ai-usage 鍙傛暟瓒婄晫杩斿洖 400', async (t) => {
  const { app } = await buildApp([]);
  t.after(() => app.close());
  const token = `Bearer ${signToken({ id: 7, username: 'tester', role: 'user' })}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/ai-usage?days=0', headers: { authorization: token } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/ai-usage?days=9999', headers: { authorization: token } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/ai-usage?pageSize=101', headers: { authorization: token } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/stats/ai-usage?page=0', headers: { authorization: token } })).statusCode, 400);
});
