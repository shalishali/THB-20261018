import test from 'node:test';
import assert from 'node:assert/strict';
import { collectParsedImports } from './multipart';

// 回归：不支持的扩展名也必须消费该 multipart part，否则请求会挂起（2026-10-21 上线测试发现）。
test('collectParsedImports：不支持的文件类型会被拒绝且消费掉 part', async () => {
  let consumed = false;
  const part = {
    filename: 'malware.exe',
    async toBuffer() {
      consumed = true;
      return Buffer.from('not supported');
    },
  };
  const req = {
    files: async function* files() {
      yield part;
    },
  };
  const result = await collectParsedImports(req as never);
  assert.equal(consumed, true, '不支持类型的 part 必须被读空，否则请求会挂起');
  assert.equal(result.docs.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /不支持的文件类型/);
});
