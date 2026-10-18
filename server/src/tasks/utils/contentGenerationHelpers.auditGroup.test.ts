import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConsistencyAuditGroupWordLimit } from './contentGenerationHelpers';

test('400000 上下文 → 分组上限 200000', () => {
  assert.equal(resolveConsistencyAuditGroupWordLimit(400000), 200000);
});

test('131072 上下文 → 分组上限 65536', () => {
  assert.equal(resolveConsistencyAuditGroupWordLimit(131072), 65536);
});

test('缺省/非法 → 回退硬上限 300000', () => {
  assert.equal(resolveConsistencyAuditGroupWordLimit(undefined), 300000);
  assert.equal(resolveConsistencyAuditGroupWordLimit(null), 300000);
  assert.equal(resolveConsistencyAuditGroupWordLimit('not-a-number'), 300000);
  assert.equal(resolveConsistencyAuditGroupWordLimit(-1), 300000);
});

test('下限 20000：20000 上下文 → 20000（floor 10000 被下限抬起）', () => {
  assert.equal(resolveConsistencyAuditGroupWordLimit(20000), 20000);
});

test('上限 300000：700000 上下文 → 300000（floor 350000 被上限压回）', () => {
  assert.equal(resolveConsistencyAuditGroupWordLimit(700000), 300000);
});
