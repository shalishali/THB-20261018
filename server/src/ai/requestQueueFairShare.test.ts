import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiRequestQueue } from './requestQueue';

// 公平调度：多用户争抢时单人最多占 1/3 池子；单用户独占时可用满池子。

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('两个用户争抢时，后到用户的请求先于先到用户的超额请求执行', async () => {
  const queue = createAiRequestQueue({ limit: 3, waitNotifyMs: 10 });
  const order: string[] = [];
  const gates = Array.from({ length: 4 }, () => deferred());

  // 用户 A 先占满 3 个槽
  const a = ['a1', 'a2', 'a3'].map((tag, index) => queue.enqueue(async () => {
    order.push(tag);
    await gates[index].promise;
    return tag;
  }, { userId: 'A' }));

  // 等待 A 的三个任务全部启动
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['a1', 'a2', 'a3']);

  // 用户 B 的请求入队 + 用户 A 的第 4 个请求排队
  const bPromise = queue.enqueue(async () => { order.push('b1'); return 'b1'; }, { userId: 'B' });
  const a4 = queue.enqueue(async () => { order.push('a4'); return 'a4'; }, { userId: 'A' });

  // 释放 a1 → 空出的槽必须给 b1（A 已到 1/3 上限=1），a4 继续等
  gates[0].resolve();
  await a[0];
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(order.slice(0, 4).join(','), 'a1,a2,a3,b1');

  // 释放 a2 → 队列里只剩用户 A 的请求（独占场景），a4 获得空槽
  gates[1].resolve();
  await a[1];
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(order.includes('a4'));
  assert.ok(order.indexOf('b1') < order.indexOf('a4'), 'b1 应先于 a4 执行');

  gates[2].resolve();
  gates[3].resolve();
  await Promise.all([a[2], a[3], a4, bPromise]);
});

test('单用户独占队列时不设 1/3 上限，可用满整个池子', async () => {
  const queue = createAiRequestQueue({ limit: 3, waitNotifyMs: 10 });
  let started = 0;
  const gates = Array.from({ length: 5 }, () => deferred());
  const jobs = ['j1', 'j2', 'j3', 'j4', 'j5'].map((_, index) => queue.enqueue(async () => {
    started += 1;
    await gates[index].promise;
    return index;
  }, { userId: 'solo' }));

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(started, 3, '单用户也应先占满 limit=3 的池子');

  gates.forEach((gate) => gate.resolve());
  await Promise.all(jobs);
  assert.equal(started, 5);
});
