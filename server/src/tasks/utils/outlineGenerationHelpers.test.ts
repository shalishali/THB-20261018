import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMirrorProcurement } from './outlineGenerationHelpers';

test('镜像采购需求开关缺省时默认关闭（不生成「项目概述」镜像章）', () => {
  assert.equal(normalizeMirrorProcurement(undefined, undefined), false);
  assert.equal(normalizeMirrorProcurement({}, {}), false);
});

test('镜像采购需求开关显式开启仍生效（payload / 工作区状态 / meta 三级兜底）', () => {
  assert.equal(normalizeMirrorProcurement({ mirror_procurement: true }, {}), true);
  assert.equal(normalizeMirrorProcurement({}, { mirrorProcurement: true }), true);
  assert.equal(normalizeMirrorProcurement({}, { mirrorProcurementEnabled: true }), true);
  // payload 显式关闭优先于存量开启
  assert.equal(normalizeMirrorProcurement({ mirror_procurement: false }, { mirrorProcurement: true }), false);
});
