import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { seedInitialAdmin } from './seedInitialAdmin';

function makePrismaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`test Prisma error ${code}`), { code });
}

interface SeedTransaction {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  user: {
    count(): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

test('空用户表创建必须改密的 admin/admin', async () => {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const user = {
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => { created.push(args); return args.data; },
  };
  const result = await seedInitialAdmin({
    $transaction: async (run) => run({ $executeRawUnsafe: async () => 0, user }),
  });
  assert.equal(result, 'created');
  assert.equal(created[0].data.username, 'admin');
  assert.equal(created[0].data.mustChangePassword, true);
  assert.equal(await bcrypt.compare('admin', String(created[0].data.password)), true);
});

test('非空用户表跳过且不写用户', async () => {
  let createCalls = 0;
  const user = {
      count: async () => 1,
      create: async () => { createCalls += 1; return {}; },
  };
  const result = await seedInitialAdmin({
    $transaction: async (run) => run({ $executeRawUnsafe: async () => 0, user }),
  });
  assert.equal(result, 'skipped');
  assert.equal(createCalls, 0);
});

test('空表判断和管理员创建在串行化表锁事务中完成', async () => {
  const events: string[] = [];
  const db = {
    user: {
      count: async () => { events.push('direct-count'); return 0; },
      create: async () => { events.push('direct-create'); return {}; },
    },
    $transaction: async <T>(
      run: (tx: SeedTransaction) => Promise<T>,
      options?: { isolationLevel?: string },
    ): Promise<T> => {
      events.push(`transaction:${options?.isolationLevel ?? 'none'}`);
      return run({
        $executeRawUnsafe: async (sql) => {
          events.push(`lock:${sql}`);
          return 0;
        },
        user: {
          count: async () => { events.push('transaction-count'); return 0; },
          create: async () => { events.push('transaction-create'); return {}; },
        },
      });
    },
  };

  const result = await seedInitialAdmin(db);

  assert.equal(result, 'created');
  assert.deepEqual(events, [
    'transaction:Serializable',
    'lock:LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE',
    'transaction-count',
    'transaction-create',
  ]);
});

test('唯一约束导致的种子竞争按已存在用户跳过', async () => {
  const db = {
    user: {
      count: async () => 0,
      create: async () => { throw makePrismaError('P2002'); },
    },
    $transaction: async <T>(run: (tx: SeedTransaction) => Promise<T>): Promise<T> => run({
      $executeRawUnsafe: async () => 0,
      user: {
        count: async () => 0,
        create: async () => { throw makePrismaError('P2002'); },
      },
    }),
  };

  assert.equal(await seedInitialAdmin(db), 'skipped');
});

test('可重试事务冲突后重新执行种子事务', async () => {
  let transactionAttempts = 0;
  const db = {
    user: {
      count: async () => 0,
      create: async () => ({}),
    },
    $transaction: async <T>(run: (tx: SeedTransaction) => Promise<T>): Promise<T> => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) throw makePrismaError('P2034');
      return run({
        $executeRawUnsafe: async () => 0,
        user: {
          count: async () => 0,
          create: async () => ({}),
        },
      });
    },
  };

  assert.equal(await seedInitialAdmin(db), 'created');
  assert.equal(transactionAttempts, 2);
});

// ---- H2 加固：生产环境不再使用 admin/admin ----

test('生产环境首启生成随机密码而非 admin/admin', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  const created: Array<{ data: Record<string, unknown> }> = [];
  const db = {
    user: {
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => { created.push(args); return args.data; },
    },
    $transaction: async <T>(run: (tx: SeedTransaction) => Promise<T>): Promise<T> => run({
      $executeRawUnsafe: async () => 0,
      user: { count: async () => 0, create: async (args: { data: Record<string, unknown> }) => { created.push(args); return args.data; } },
    }),
  };

  assert.equal(await seedInitialAdmin(db), 'created');
  assert.notEqual(await bcrypt.compare('admin', String(created[0].data.password)), true);
});

test('ADMIN_INITIAL_PASSWORD 优先于环境判定', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  const previousPassword = process.env.ADMIN_INITIAL_PASSWORD;
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_INITIAL_PASSWORD = 'Deploy-Injected-Passw0rd!';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (previousPassword === undefined) delete process.env.ADMIN_INITIAL_PASSWORD; else process.env.ADMIN_INITIAL_PASSWORD = previousPassword;
  });

  const created: Array<{ data: Record<string, unknown> }> = [];
  const db = {
    user: {
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => { created.push(args); return args.data; },
    },
    $transaction: async <T>(run: (tx: SeedTransaction) => Promise<T>): Promise<T> => run({
      $executeRawUnsafe: async () => 0,
      user: { count: async () => 0, create: async (args: { data: Record<string, unknown> }) => { created.push(args); return args.data; } },
    }),
  };

  await seedInitialAdmin(db);
  assert.equal(await bcrypt.compare('Deploy-Injected-Passw0rd!', String(created[0].data.password)), true);
});
