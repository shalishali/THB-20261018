import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { quotaPublicRoutes } from './quota';

test('公开计价接口不需要登录且只返回套餐/赠送额度', async (t) => {
  const app = Fastify();
  app.decorate('prisma', {
    quotaConfig: {
      findUnique: async () => ({
        signupGrantChars: 120000,
        plans: [
          { key: 'plan-10w', label: '10 万字', chars: 100000, amountCents: 390 },
          { key: 'plan-20w', label: '20 万字', chars: 200000, amountCents: 500 },
        ],
      }),
    },
  } as unknown as PrismaClient);
  await app.register(quotaPublicRoutes);
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/quota/public-pricing' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    signupGrantChars: 120000,
    plans: [
      { key: 'plan-10w', label: '10 万字', chars: 100000, amountCents: 390 },
      { key: 'plan-20w', label: '20 万字', chars: 200000, amountCents: 500 },
    ],
  });
  assert.equal('quotaChars' in response.json(), false);
  assert.equal('userId' in response.json(), false);
});
