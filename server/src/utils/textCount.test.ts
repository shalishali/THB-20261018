import assert from 'node:assert/strict';
import test from 'node:test';
import { countOutlineContentChars, countReadableChars } from './textCount';

test('Markdown 标签剥离，但代码围栏内容计入（与导出渲染同源，防免费导出绕过）', () => {
  const sample = '# 方案概述\n\n本项目采用**微服务架构**，工期 180 天。\n\n```mermaid\ngraph TD\n A-->B\n```\n';
  const base = countReadableChars('# 方案概述\n\n本项目采用**微服务架构**，工期 180 天。\n');
  const fenced = countReadableChars('```mermaid\ngraph TD\n A-->B\n```');
  assert.ok(fenced > 0, '围栏内容必须计入');
  assert.equal(countReadableChars(sample), base + fenced);
});

test('纯围栏内容不再被计为 0（历史绕过手法）', () => {
  assert.ok(countReadableChars('```\n任意长度的正文\n```') > countReadableChars('任意长度的正文'));
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
