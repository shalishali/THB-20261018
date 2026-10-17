import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';

test('受限令牌只能通过初始改密校验', async () => {
  const auth = await import('./middleware');
  const token = auth.signInitialPasswordChangeToken({ id: 1, username: 'admin', role: 'admin' });
  const decoded = jwt.decode(token) as { iat?: number; exp?: number };

  assert.equal(decoded.exp! - decoded.iat!, 600);
  assert.equal(auth.verifyInitialPasswordChangeToken(token).purpose, 'initial-password-change');
  assert.throws(() => auth.verifyAccessToken(token));
});

test('旧正式令牌没有 purpose 时继续兼容', async () => {
  const auth = await import('./middleware');
  const token = jwt.sign(
    { id: 2, username: 'legacy', role: 'user' },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' },
  );

  assert.equal(auth.verifyAccessToken(token).username, 'legacy');
});

test('未知 purpose 的签名令牌不能作为正式访问令牌', async () => {
  const auth = await import('./middleware');
  const token = jwt.sign(
    { id: 3, username: 'unexpected', role: 'user', purpose: 'service-token' },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' },
  );

  assert.throws(() => auth.verifyAccessToken(token));
});

test('正式令牌不能用于初始改密', async () => {
  const auth = await import('./middleware');
  const token = auth.signToken({ id: 1, username: 'admin', role: 'admin' });
  const decoded = jwt.decode(token) as { purpose?: string; iat?: number; exp?: number };

  assert.equal(decoded.purpose, 'access');
  assert.equal(decoded.exp! - decoded.iat!, 7 * 24 * 60 * 60);
  assert.throws(() => auth.verifyInitialPasswordChangeToken(token));
});

test('受限令牌不能访问普通受保护路由', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/protected', { onRequest: auth.createVerifyToken(makeUserDb({ id: 1, role: 'admin' })) }, async () => ({ success: true }));

  const restrictedResponse = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: {
      authorization: `Bearer ${auth.signInitialPasswordChangeToken({ id: 1, username: 'admin', role: 'admin' })}`,
    },
  });
  assert.equal(restrictedResponse.statusCode, 401);

  const accessResponse = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: {
      authorization: `Bearer ${auth.signToken({ id: 1, username: 'admin', role: 'admin' })}`,
    },
  });
  assert.equal(accessResponse.statusCode, 200);
});

// ---- H1 加固：verifyToken 回查库（用户存在性 + tokenVersion 吊销 + role 以库为准）----

interface FakeUserRow {
  id: number;
  username?: string;
  role: string;
  tokenVersion?: number;
}

function makeUserDb(row: FakeUserRow) {
  return {
    user: {
      findUnique: async () => ({ username: 'admin', ...row, tokenVersion: row.tokenVersion ?? 0 }),
    },
  } as never;
}

test('tokenVersion 与库中不一致的令牌被吊销', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  // 用户当前 tokenVersion=1（已改密/降权），令牌仍是旧版本 0
  app.get('/protected', { onRequest: auth.createVerifyToken(makeUserDb({ id: 1, role: 'user', tokenVersion: 1 })) }, async () => ({ success: true }));

  const staleToken = auth.signToken({ id: 1, username: 'admin', role: 'admin', tokenVersion: 0 });
  const response = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${staleToken}` },
  });
  assert.equal(response.statusCode, 401);
});

test('用户已被删除时令牌失效', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/protected', {
    onRequest: auth.createVerifyToken({ user: { findUnique: async () => null } } as never),
  }, async () => ({ success: true }));

  const token = auth.signToken({ id: 42, username: 'gone', role: 'user', tokenVersion: 0 });
  const response = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 401);
});

test('角色以库中最新值为准而非令牌 claim', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  // 令牌 claim 是 admin，但库里已降权为 user
  let seenRole = '';
  app.get('/protected', { onRequest: auth.createVerifyToken(makeUserDb({ id: 1, role: 'user', tokenVersion: 0 })) }, async (req) => {
    seenRole = (req as unknown as { user: { role: string } }).user.role;
    return { success: true };
  });

  const staleAdminToken = auth.signToken({ id: 1, username: 'admin', role: 'admin', tokenVersion: 0 });
  const response = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${staleAdminToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(seenRole, 'user');
});

test('令牌未携带 tokenVersion 时按 0 兼容旧令牌', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/protected', { onRequest: auth.createVerifyToken(makeUserDb({ id: 1, role: 'user', tokenVersion: 0 })) }, async () => ({ success: true }));

  const legacyToken = jwt.sign({ id: 1, username: 'u', role: 'user' }, process.env.JWT_SECRET as string, { expiresIn: '7d' });
  const response = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${legacyToken}` },
  });
  assert.equal(response.statusCode, 200);
});
