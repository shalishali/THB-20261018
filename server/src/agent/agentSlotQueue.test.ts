import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSlotQueue } from './agentSlotQueue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('空闲时 acquire 立即获得执行权', async () => {
  const queue = new AgentSlotQueue();
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  assert.equal(queue.size, 0);
  queue.release();
});

test('忙时 FIFO 排队：release 按到达顺序移交锁', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 60_000 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');

  const b = queue.acquire({ title: 'B' });
  const c = queue.acquire({ title: 'C' });
  await delay(10);
  assert.equal(queue.size, 2);
  assert.deepEqual(
    queue.getStats().map((task) => task.title),
    ['B', 'C'],
  );
  assert.equal(queue.getStats()[0].position, 1);

  queue.release();
  assert.equal(await b, 'acquired');
  assert.equal(queue.size, 1);

  queue.release();
  assert.equal(await c, 'acquired');
  assert.equal(queue.size, 0);

  queue.release();
  // 全部释放后新的直通调用立即获得执行权
  assert.equal(await queue.acquire({ title: 'D' }), 'acquired');
  queue.release();
});

test('release 移交后，新的直通调用不能插队', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 60_000 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  const b = queue.acquire({ title: 'B' });
  await delay(10);

  queue.release(); // 锁移交给 B
  const c = queue.acquire({ title: 'C' }); // B 尚未恢复执行，但锁已被 B 预占 → C 排队
  assert.equal(queue.size, 1);

  assert.equal(await b, 'acquired');
  queue.release();
  assert.equal(await c, 'acquired');
  queue.release();
});

test('队列容量满时立即返回 queue-full', async () => {
  const queue = new AgentSlotQueue({ maxQueued: 1 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  const queued = queue.acquire({ title: 'B' });
  await delay(10);
  assert.equal(await queue.acquire({ title: 'C' }), 'queue-full');

  queue.release();
  assert.equal(await queued, 'acquired');
  queue.release();
});

test('排队超时返回 timeout，且不影响后续等待者', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 20 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  const b = queue.acquire({ title: 'B' });
  const c = queue.acquire({ title: 'C' });

  assert.equal(await b, 'timeout');
  assert.equal(queue.size, 1);

  queue.release();
  assert.equal(await c, 'acquired');
  queue.release();
});

test('排队中被 abort 的等待者立即出队', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 60_000 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  const controller = new AbortController();
  const b = queue.acquire({ title: 'B', signal: controller.signal });
  await delay(10);
  assert.equal(queue.size, 1);

  controller.abort(new Error('用户取消'));
  assert.equal(await b, 'aborted');
  assert.equal(queue.size, 0);

  const d = queue.acquire({ title: 'D' });
  queue.release();
  assert.equal(await d, 'acquired');
  queue.release();
});

test('已进入执行的等待者，其 abort 信号不再影响队列', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 60_000 });
  const controller = new AbortController();
  assert.equal(await queue.acquire({ title: 'A', signal: controller.signal }), 'acquired');

  controller.abort(new Error('任务执行中被取消'));
  const b = queue.acquire({ title: 'B' });
  queue.release();
  assert.equal(await b, 'acquired');
  queue.release();
});

test('close 清空队列：等待者收到 closed，此后 acquire 一律 closed', async () => {
  const queue = new AgentSlotQueue({ waitTimeoutMs: 60_000 });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  const b = queue.acquire({ title: 'B' });
  await delay(10);

  queue.close();
  assert.equal(await b, 'closed');
  assert.equal(await queue.acquire({ title: 'C' }), 'closed');
  // close 后 release 不会复活队列
  queue.release();
  assert.equal(await queue.acquire({ title: 'D' }), 'closed');
});

test('排队状态变化触发 onStatusChange 回调', async () => {
  let changes = 0;
  const queue = new AgentSlotQueue({
    waitTimeoutMs: 60_000,
    onStatusChange: () => {
      changes += 1;
    },
  });
  assert.equal(await queue.acquire({ title: 'A' }), 'acquired');
  assert.equal(changes, 0);

  const b = queue.acquire({ title: 'B' });
  await delay(10);
  assert.equal(changes, 1);

  queue.release();
  assert.equal(await b, 'acquired');
  assert.ok(changes >= 2);
  queue.release();
});
