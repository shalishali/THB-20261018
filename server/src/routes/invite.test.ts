import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { inviteRoutes } = await import('./invite');
const { createVerifyToken, signToken } = await import('../auth/middleware');

interface RelationRow {
  id: number;
  inviterId: number;
  inviteeId: number;
  registeredAt: Date;
  status: string;
  invitee: { displayName: string | null; username: string; phone: string | null };
}

function makeRelation(overrides: Partial<RelationRow> = {}): RelationRow {
  return {
    id: 1,
    inviterId: 7,
    inviteeId: 100,
    registeredAt: new Date('2026-10-01T00:00:00.000Z'),
    status: 'bound',
    invitee: { displayName: '张三', username: '13812345678', phone: '13812345678' },
    ...overrides,
  };
}

// 模拟 Prisma Decimal（仅需 toString 语义）。
function dec(value: string): { toString(): string } {
  return { toString: () => value };
}

interface FakeState {
  inviteCode: string | null;
  updates: Array<{ where: { id: number }; data: { inviteCode: string } }>;
  relationQueries: Array<{ countWhere: unknown; findWhere: unknown; orderBy: unknown; skip: number; take: number }>;
  rebateQueries: Array<unknown>;
}

async function buildApp(options: {
  inviteCode?: string | null;
  relations: RelationRow[];
  rebatePendingSum?: { toString(): string } | null;
  updateFailsOnce?: boolean;
}) {
  const state: FakeState = {
    inviteCode: options.inviteCode === undefined ? 'ABCD2345' : options.inviteCode,
    updates: [],
    relationQueries: [],
    rebateQueries: [],
  };
  let updateFailsOnce = Boolean(options.updateFailsOnce);

  const app = Fastify();
  app.decorate('prisma', {
    user: {
      // generateInviteCode 查重按 inviteCode；ensureInviteCode/兜底重读按 id；
      // H1 加固后 verifyToken 也按 id 回查（需返回 role/tokenVersion 完整行）。
      findUnique: async (args: { where: { id?: number; inviteCode?: string }; select: unknown }) => {
        const where = args.where;
        if (where.inviteCode !== undefined) {
          return state.inviteCode === where.inviteCode ? { id: 1 } : null;
        }
        return {
          id: where.id,
          username: 'tester',
          role: 'user',
          tokenVersion: 0,
          inviteCode: state.inviteCode,
        };
      },
      update: async (args: { where: { id: number }; data: { inviteCode: string } }) => {
        if (updateFailsOnce) {
          updateFailsOnce = false;
          throw new Error('Unique constraint failed on the fields: (`inviteCode`)');
        }
        state.updates.push(args);
        state.inviteCode = args.data.inviteCode;
        return { id: args.where.id };
      },
    },
    inviteRelation: {
      count: async (args: { where: unknown }) => {
        state.relationQueries.push({ countWhere: args.where, findWhere: null, orderBy: null, skip: -1, take: -1 });
        return options.relations.filter((row) => row.inviterId === (args.where as { inviterId: number }).inviterId).length;
      },
      findMany: async (args: { where: unknown; orderBy: unknown; skip: number; take: number }) => {
        state.relationQueries.push({ countWhere: null, findWhere: args.where, orderBy: args.orderBy, skip: args.skip, take: args.take });
        return options.relations
          .filter((row) => row.inviterId === (args.where as { inviterId: number }).inviterId)
          .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime())
          .slice(args.skip, args.skip + args.take);
      },
    },
    rebateFlow: {
      aggregate: async (args: unknown) => {
        state.rebateQueries.push(args);
        return { _sum: { amount: options.rebatePendingSum ?? null } };
      },
    },
    // FE：下线列表新增余额/充值展示，promotion 会按当页 invitee 聚合已核验充值
    quotaOrder: {
      groupBy: async () => [],
    },
  });
  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', createVerifyToken((app as unknown as { prisma: unknown }).prisma as never));
    await protectedApp.register(inviteRoutes, { prefix: '/api' });
  });
  return { app, state };
}

const TOKEN_7 = () => `Bearer ${signToken({ id: 7, username: 'tester', role: 'user' })}`;

test('invite/code 与 invite/promotion 未登录返回 401', async (t) => {
  const { app } = await buildApp({ relations: [] });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/api/invite/code' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/invite/promotion' })).statusCode, 401);
});

test('invite/code 已有邀请码：原样返回、不重写库、返回链接带码', async (t) => {
  const { app, state } = await buildApp({ inviteCode: 'ABCD2345', relations: [] });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/invite/code', headers: { authorization: TOKEN_7() } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.inviteCode, 'ABCD2345');
  assert.ok(body.inviteUrl.endsWith('/?invite=ABCD2345'), body.inviteUrl);
  assert.equal(state.updates.length, 0);
});

test('invite/code 存量无码用户：补生成并写回（幂等生成）', async (t) => {
  const { app, state } = await buildApp({ inviteCode: null, relations: [] });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/invite/code', headers: { authorization: TOKEN_7() } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.inviteCode, /^[A-Z0-9]{8}$|^YB/);
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].where.id, 7);
  assert.equal(state.updates[0].data.inviteCode, body.inviteCode);
  assert.ok(body.inviteUrl.includes(body.inviteCode));
});

test('invite/code 写回撞唯一约束时重读兜底不 500', async (t) => {
  const { app, state } = await buildApp({ inviteCode: null, relations: [], updateFailsOnce: true });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/invite/code', headers: { authorization: TOKEN_7() } });
  assert.equal(response.statusCode, 200);
  // 兜底重读仍为 null（fake 不变），返回本次生成值。
  assert.match(response.json().inviteCode, /^[A-Z0-9]{8}$|^YB/);
  assert.equal(state.updates.length, 0);
});

test('invite/promotion 返回本人数据：统计/脱敏/分页，且查询按 inviterId 过滤', async (t) => {
  const relations = [
    makeRelation({ id: 1, registeredAt: new Date('2026-10-01T00:00:00.000Z') }),
    makeRelation({ id: 2, inviterId: 9, inviteeId: 200, registeredAt: new Date('2026-10-02T00:00:00.000Z') }),
    makeRelation({
      id: 3,
      inviteeId: 300,
      registeredAt: new Date('2026-10-03T00:00:00.000Z'),
      invitee: { displayName: null, username: '13900001111', phone: '13900001111' },
    }),
  ];
  const { app, state } = await buildApp({ inviteCode: 'WXYZ6789', relations, rebatePendingSum: dec('12.50') });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: '/api/invite/promotion?page=1&pageSize=10',
    headers: { authorization: TOKEN_7() },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.inviteCode, 'WXYZ6789');
  assert.ok(body.inviteUrl.endsWith('/?invite=WXYZ6789'));
  assert.equal(body.inviteeCount, 2); // inviterId=9 的关系不计入
  assert.equal(body.pendingRebateAmount, '12.50');
  assert.equal(body.total, 2);
  assert.equal(body.items.length, 2);
  // 排序：registeredAt desc。
  assert.equal(body.items[0].id, 3);
  // 脱敏：姓名保留首字；displayName 缺失回退 username；手机号前 3 后 4。
  assert.equal(body.items[1].name, '张*');
  assert.equal(body.items[1].phone, '138****5678');
  assert.equal(body.items[0].name, '1***');
  assert.equal(body.items[0].phone, '139****1111');
  // API-08：查询必须按本人 inviterId 过滤。
  const countQuery = state.relationQueries.find((q) => q.countWhere !== null);
  const findQuery = state.relationQueries.find((q) => q.findWhere !== null);
  assert.deepEqual(countQuery?.countWhere, { inviterId: 7 });
  assert.deepEqual(findQuery?.findWhere, { inviterId: 7 });
  assert.equal(findQuery?.skip, 0);
  assert.equal(findQuery?.take, 10);
  assert.deepEqual(state.rebateQueries[0], { where: { inviterId: 7, settleStatus: 'pending' }, _sum: { amount: true } });
});

test('invite/promotion 无返利流水时金额为 0.00', async (t) => {
  const { app } = await buildApp({ relations: [], rebatePendingSum: null });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/invite/promotion', headers: { authorization: TOKEN_7() } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pendingRebateAmount, '0.00');
});

test('invite/promotion 参数越界返回 400', async (t) => {
  const { app } = await buildApp({ relations: [] });
  t.after(() => app.close());
  const token = TOKEN_7();
  assert.equal((await app.inject({ method: 'GET', url: '/api/invite/promotion?page=0', headers: { authorization: token } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/invite/promotion?pageSize=101', headers: { authorization: token } })).statusCode, 400);
});
