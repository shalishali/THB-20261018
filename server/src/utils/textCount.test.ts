import assert from 'node:assert/strict';
import test from 'node:test';
import { countOutlineContentChars, countReadableChars } from './textCount';

test('剥 Markdown/代码块后逐字符计数（含标点与字母，去空白）', () => {
  const sample = '# 方案概述\n\n本项目采用**微服务架构**，工期 180 天。\n\n```mermaid\ngraph TD\n A-->B\n```\n';
  // 剥离后可读文本 = "方案概述本项目采用微服务架构，工期180天。"
  assert.equal(countReadableChars(sample), '方案概述本项目采用微服务架构，工期180天。'.length);
});

test('链接保留文字、图片剥离', () => {
  assert.equal(countReadableChars('[投好标](https://x.com) 与 ![图](y.png) 好'), '投好标与好'.length);
});

test('空内容为 0', () => {
  assert.equal(countReadableChars(''), 0);
  assert.equal(countReadableChars(null as never), 0);
});

test('大纲递归：子节点计入', () => {
  const outline = [{ content: '第一节', children: [{ content: '子节' }] }];
  assert.equal(countOutlineContentChars(outline), 5);
});
