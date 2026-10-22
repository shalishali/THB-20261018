// 充值订单主动对账单测：不连数据库、不请求支付宝，全部用桩对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePendingQuotaOrders, reconcileQuotaOrder } from './reconcile';
import type { AlipayConfig } from './config';

const config: AlipayConfig = {
  appId: 'test-app',
  privateKey: 'test-private-key',
  alipayPublicKey: 'test-public-key',
  gateway: 'https://example.invalid/gateway.do',
  notifyUrl: 'https://example.invalid/notify',
  returnUrl: 'https://example.invalid/return',
};

function fakeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    userId: 7,
    outTradeNo: 'QTEST1',
    channel: 'alipay',
    status: 'pending',
    chars: 100000,
    amountCents: 390,
    ...overrides,
  };
}

function fakePrisma(order: Record<string, unknown>) {
  return { quotaOrder: { findUnique: async () => order } } as never;
}

function markPaidStub() {
  const calls: string[] = [];
  return {
    calls,
    fn: async (_prisma: unknown, orderId: string) => {
      calls.push(orderId);
      return {
        ok: true,
        message: '已入账',
        order: { id: orderId, userId: 7, outTradeNo: 'QTEST1', chars: 100000, amountCents: 390, alreadyPaid: false },
      };
    },
  };
}

test('支付宝交易成功且金额一致才入账', async () => {
  const mark = markPaidStub();
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder()), 'order-1', {
    config,
    markPaid: mark.fn,
    queryTrade: async () => ({ ok: true, found: true, tradeStatus: 'TRADE_SUCCESS', amountCents: 390, tradeNo: 'T1' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.paid, true);
  assert.deepEqual(mark.calls, ['order-1']);
});

test('支付宝交易成功但金额不一致拒绝入账', async () => {
  const mark = markPaidStub();
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder()), 'order-1', {
    config,
    markPaid: mark.fn,
    queryTrade: async () => ({ ok: true, found: true, tradeStatus: 'TRADE_SUCCESS', amountCents: 1, tradeNo: 'T1' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.paid, false);
  assert.deepEqual(mark.calls, []);
});

test('支付宝查不到交易时保持待支付，不记失败', async () => {
  const mark = markPaidStub();
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder()), 'order-1', {
    config,
    markPaid: mark.fn,
    queryTrade: async () => ({ ok: true, found: false }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.paid, false);
  assert.deepEqual(mark.calls, []);
});

test('支付宝查询失败时不入账', async () => {
  const mark = markPaidStub();
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder()), 'order-1', {
    config,
    markPaid: mark.fn,
    queryTrade: async () => ({ ok: false, found: false, error: 'network down' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.paid, false);
  assert.deepEqual(mark.calls, []);
});

test('已支付订单直接幂等返回，不再请求支付宝', async () => {
  let queried = false;
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder({ status: 'paid' })), 'order-1', {
    config,
    queryTrade: async () => {
      queried = true;
      return { ok: true, found: true, tradeStatus: 'TRADE_SUCCESS', amountCents: 390 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.paid, true);
  assert.equal(result.alreadyPaid, true);
  assert.equal(queried, false);
});

test('已关闭订单不能再次入账', async () => {
  const mark = markPaidStub();
  const result = await reconcileQuotaOrder(fakePrisma(fakeOrder({ status: 'closed' })), 'order-1', {
    config,
    markPaid: mark.fn,
    queryTrade: async () => ({ ok: true, found: true, tradeStatus: 'TRADE_SUCCESS', amountCents: 390 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.paid, false);
  assert.deepEqual(mark.calls, []);
});

test('批量对账区分入账、待支付与失败', async () => {
  const orders = [fakeOrder({ id: 'o1', outTradeNo: 'Q1' }), fakeOrder({ id: 'o2', outTradeNo: 'Q2' })];
  const prisma = {
    quotaOrder: {
      findMany: async () => orders.map((order) => ({ id: order.id, outTradeNo: order.outTradeNo })),
      findUnique: async ({ where }: { where: { id: string } }) => orders.find((order) => order.id === where.id) || null,
    },
  } as never;
  const mark = markPaidStub();
  const summary = await reconcilePendingQuotaOrders(prisma, {
    limit: 10,
    lookbackHours: 24,
    config,
    markPaid: mark.fn,
    queryTrade: async (_config, outTradeNo) => {
      if (outTradeNo === 'Q1') return { ok: true, found: true, tradeStatus: 'TRADE_SUCCESS', amountCents: 390 };
      if (outTradeNo === 'Q2') return { ok: true, found: false };
      return { ok: false, found: false, error: 'boom' };
    },
  });
  assert.deepEqual(
    { checked: summary.checked, paid: summary.paid, pending: summary.pending, failed: summary.failed },
    { checked: 2, paid: 1, pending: 1, failed: 0 },
  );
  assert.deepEqual(mark.calls, ['o1']);
});
