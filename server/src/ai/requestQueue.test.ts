import test from 'node:test';
import assert from 'node:assert/strict';

import { createAiRequestQueue, type AiQueueWaitInfo } from './requestQueue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('请求排队超过 waitNotifyMs 后周期上报队列快照，获得执行权后停止上报', async () => {
  const queue = createAiRequestQueue({ limit: 1, waitNotifyMs: 20 });
  const infos: AiQueueWaitInfo[] = [];
  let releaseA!: () => void;
  const a = queue.enqueue(async () => new Promise<void>((resolve) => { releaseA = resolve; }), {});
  const b = queue.enqueue(async () => 'b-done', { onQueueWait: (info) => infos.push(info) });

  await delay(70);
  assert.ok(infos.length >= 1, '排队超过 waitNotifyMs 后应有至少一次上报');
  assert.equal(infos[0].position, 1);
  assert.equal(infos[0].ahead, 0);
  assert.equal(infos[0].active, 1);
  assert.equal(infos[0].queued, 1);
  assert.equal(infos[0].limit, 1);

  const countBefore = infos.length;
  releaseA();
  await a;
  assert.equal(await b, 'b-done');
  await delay(70);
  assert.equal(infos.length, countBefore, '获得执行权后不再上报');
});

test('多个请求排队时各自上报正确的 position/ahead', async () => {
  const queue = createAiRequestQueue({ limit: 1, waitNotifyMs: 20 });
  const latest = new Map<string, { ahead: number; position: number }>();
  let releaseA!: () => void;
  const a = queue.enqueue(async () => new Promise<void>((resolve) => { releaseA = resolve; }), {});
  const b = queue.enqueue(async () => 'b-done', { onQueueWait: (info) => latest.set('b', { ahead: info.ahead, position: info.position }) });
  const c = queue.enqueue(async () => 'c-done', { onQueueWait: (info) => latest.set('c', { ahead: info.ahead, position: info.position }) });

  await delay(70);
  assert.deepEqual(latest.get('b'), { ahead: 0, position: 1 });
  assert.deepEqual(latest.get('c'), { ahead: 1, position: 2 });

  releaseA();
  await Promise.all([a, b, c]);
});

test('pauseScope 丢弃排队请求后停止上报', async () => {
  const queue = createAiRequestQueue({ limit: 1, waitNotifyMs: 20 });
  let notified = 0;
  let releaseA!: () => void;
  const a = queue.enqueue(async () => new Promise<void>((resolve) => { releaseA = resolve; }), {});
  const b = queue.enqueue(async () => 'never', { scopeId: 'task-1', onQueueWait: () => { notified += 1; } });

  await delay(70);
  assert.ok(notified >= 1);
  assert.equal(queue.pauseScope('task-1'), 1);
  const countBefore = notified;
  await assert.rejects(b, /AI 请求队列已暂停/);
  releaseA();
  await a;
  await delay(70);
  assert.equal(notified, countBefore, '出队（暂停丢弃）后不再上报');
});

test('未注册 onQueueWait 的请求排队行为不受影响', async () => {
  const queue = createAiRequestQueue({ limit: 1, waitNotifyMs: 20 });
  let releaseA!: () => void;
  const a = queue.enqueue(async () => new Promise<void>((resolve) => { releaseA = resolve; }), {});
  const b = queue.enqueue(async () => 'ok', {});
  releaseA();
  await a;
  assert.equal(await b, 'ok');
});
