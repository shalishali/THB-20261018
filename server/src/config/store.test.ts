import assert from 'node:assert/strict';
import test from 'node:test';

// 不 import store 的其它依赖（会读 env/db）也无妨：redactSecrets 是纯函数。
const { redactSecrets } = await import('./store');

// P0 回归：普通用户可调 PUT /api/config/user（saveUserConfig 内部用 buildMerged + redactSecrets），
// 任何下发给非管理员的 config 都必须不含平台密钥——文本/生图/解析/Key 池全部清空。
test('redactSecrets 清空全部密钥字段（含生图 Key 池与解析 token）', () => {
  const config = {
    api_key: 'sk-text-flat',
    text_model_profiles: {
      deepseek: { api_key: 'sk-a', api_keys: ['sk-b', 'sk-c'], model_name: 'deepseek-flash' },
    },
    image_model_profiles: {
      openai: { api_key: 'sk-image', api_keys: ['sk-image-2'] },
    },
    image_model: { api_key: 'sk-image-flat', provider: 'openai' },
    file_parser: { provider: 'mineru', mineru_token: 'mineru-secret' },
  };
  const redacted = redactSecrets(config);
  assert.equal(redacted.api_key, '');
  assert.equal(redacted.text_model_profiles.deepseek.api_key, '');
  assert.deepEqual(redacted.text_model_profiles.deepseek.api_keys, []);
  assert.equal(redacted.text_model_profiles.deepseek.model_name, 'deepseek-flash');
  assert.equal(redacted.image_model_profiles.openai.api_key, '');
  assert.deepEqual(redacted.image_model_profiles.openai.api_keys, []);
  assert.equal(redacted.image_model.api_key, '');
  assert.equal(redacted.file_parser.mineru_token, '');
});

test('redactSecrets 不修改入参（避免把进程内缓存里的真实 key 清掉）', () => {
  const config = { api_key: 'sk-keep', text_model_profiles: { a: { api_key: 'sk-a' } } };
  const redacted = redactSecrets(config);
  assert.equal(config.api_key, 'sk-keep');
  assert.equal(config.text_model_profiles.a.api_key, 'sk-a');
  assert.equal(redacted.api_key, '');
});
