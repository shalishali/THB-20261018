import assert from 'node:assert/strict';
import test from 'node:test';
import { pickRotatedApiKey, reportKeyFailure, reportKeySuccess, resolveApiKeyPool } from './keyPool';

test('单 key 条目沿用主配置的 Base URL 与模型名', () => {
  const pool = resolveApiKeyPool({ base_url: 'https://api.a.com', model_name: 'model-a', api_key: 'sk-main' });
  assert.deepEqual(pool, [{ key: 'sk-main', base_url: 'https://api.a.com', model_name: 'model-a' }]);
});

test('跨平台条目：Key|Base URL|模型名 解析出各自端点与模型', () => {
  const pool = resolveApiKeyPool({
    base_url: 'https://api.a.com',
    model_name: 'model-a',
    api_key: 'sk-main',
    api_keys: ['sk-b|https://api.b.com|model-b', 'sk-c|https://api.c.com'],
  });
  assert.equal(pool.length, 3);
  // api_keys 在前、单 key 兜底
  assert.deepEqual(pool[0], { key: 'sk-b', base_url: 'https://api.b.com', model_name: 'model-b' });
  // 未指定模型名的跨平台条目回落主配置模型
  assert.deepEqual(pool[1], { key: 'sk-c', base_url: 'https://api.c.com', model_name: 'model-a' });
  assert.deepEqual(pool[2], { key: 'sk-main', base_url: 'https://api.a.com', model_name: 'model-a' });
});

test('轮询：两条目交替出现', () => {
  const config = { base_url: 'https://api.a.com', model_name: 'm', api_keys: ['k1', 'k2'] };
  const picks = [pickRotatedApiKey(config)?.key, pickRotatedApiKey(config)?.key, pickRotatedApiKey(config)?.key];
  assert.deepEqual(picks, ['k1', 'k2', 'k1']);
});

test('冷却中的坏 key 被跳过，恢复后重新参与', () => {
  const config = { base_url: 'https://api.b.com', model_name: 'cooldown-m', api_keys: ['good', 'bad'] };
  reportKeyFailure('bad');
  const pick = (): string => pickRotatedApiKey(config)?.key || '';
  assert.equal(pick(), 'good');
  assert.equal(pick(), 'good');
  reportKeySuccess('bad');
  assert.ok(['good', 'bad'].includes(pick()));
});

test('空池返回 null（上方调用方据此报配置缺失）', () => {
  assert.equal(pickRotatedApiKey({}), null);
});

test('任务级亲和：同一亲和键稳定锁定同一条目（单文档不跨模型）', () => {
  const config = {
    base_url: 'https://api.a.com',
    model_name: 'm',
    api_keys: ['k1', 'k2', 'k3'],
    __poolAffinity: 'project-93:content-generation:task-1',
  };
  const first = pickRotatedApiKey(config)?.key;
  for (let i = 0; i < 6; i += 1) {
    assert.equal(pickRotatedApiKey(config)?.key, first);
  }
});

test('任务级亲和：不同亲和键可落到不同条目（跨项目防雷同路由）', () => {
  const base = { base_url: 'https://api.a.com', model_name: 'm', api_keys: ['k1', 'k2', 'k3'] };
  const keys = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((seed) => pickRotatedApiKey({ ...base, __poolAffinity: seed })?.key));
  assert.ok(keys.size > 1);
});

test('任务级亲和：锁定条目冷却时回退轮询（可用性优先）', () => {
  const config = { base_url: 'https://api.a.com', model_name: 'm2', api_keys: ['k1', 'k2'], __poolAffinity: 'lock-k1' };
  const locked = pickRotatedApiKey(config)?.key;
  assert.ok(locked);
  reportKeyFailure(locked as string);
  const after = pickRotatedApiKey(config)?.key;
  assert.notEqual(after, locked);
  reportKeySuccess(locked as string);
});
