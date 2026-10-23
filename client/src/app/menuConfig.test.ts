import assert from 'node:assert/strict';
import test from 'node:test';

import { getAppMenuItems } from './menuConfig';

function flattenMenuItems() {
  return getAppMenuItems(false).flatMap((item) => [item, ...(item.children ?? [])]);
}

test('资源下载模块不再出现在主菜单或子菜单中', () => {
  const ids = flattenMenuItems().map((item) => item.id) as string[];
  assert.equal(ids.includes('resources'), false);
});

test('投标计算器入口已从菜单隐藏', () => {
  // 功能入口已下线（FE-03），路由/页面代码暂留；菜单不得再暴露 business-bid。
  assert.equal(flattenMenuItems().some((item) => item.id === 'business-bid'), false);
});
