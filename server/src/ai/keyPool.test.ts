import assert from 'node:assert/strict';
import test from 'node:test';
import { pickRotatedApiKey, resolveApiKeyPool } from './keyPool';

test('resolveApiKeyPool：合并单 key 与池子并去重去空', () => {
  const pool = resolveApiKeyPool({ api_key: 'k1', api_keys: ['k2', 'k1', '', 'k3'] });
  assert.deepEqual(pool, ['k2', 'k1', 'k3']);
});

test('resolveApiKeyPool：仅单 key / 全空', () => {
  assert.deepEqual(resolveApiKeyPool({ api_key: 'k1' }), ['k1']);
  assert.deepEqual(resolveApiKeyPool({}), []);
});

test('pickRotatedApiKey：多 key 轮询循环', () => {
  const config = { base_url: 'https://x/v1', model_name: 'm', api_key: 'k1', api_keys: ['k2', 'k3'] };
  const picks = [pickRotatedApiKey(config), pickRotatedApiKey(config), pickRotatedApiKey(config)];
  assert.deepEqual(new Set(picks).size, 3, '三次请求应覆盖三个不同 key');
});

test('pickRotatedApiKey：空池返回空串，单 key 恒定', () => {
  assert.equal(pickRotatedApiKey({}), '');
  const config = { api_key: 'only' };
  assert.equal(pickRotatedApiKey(config), 'only');
  assert.equal(pickRotatedApiKey(config), 'only');
});
