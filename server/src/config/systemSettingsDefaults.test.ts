import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from './normalize';

test('初次部署默认系统名称为投好标（品牌名定稿 2026-10-17）', () => {
  assert.equal(defaultConfig.system_name, '投好标');
});
