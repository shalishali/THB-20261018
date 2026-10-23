import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitialPasswordRuleState,
  validateInitialPassword,
} from './initialPassword';

test('至少 8 位且非默认密码通过', () => {
  assert.deepEqual(validateInitialPassword('Strong-Pass1!'), []);
  assert.deepEqual(validateInitialPassword('12345678'), []);
});

test('拒绝少于 8 位和默认密码', () => {
  assert.equal(getInitialPasswordRuleState('1234567').minLength, false);
  assert.match(validateInitialPassword('1234567').join('；'), /至少 8 位/);
  assert.match(validateInitialPassword('admin').join('；'), /默认密码/);
});
