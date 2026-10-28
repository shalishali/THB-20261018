import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { engines?: { node?: string } };

test('client 显式声明 Node >=22，避免低版本测试静默零覆盖', () => {
  assert.equal(clientPackage.engines?.node, '>=22');
});
