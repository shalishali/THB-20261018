import assert from 'node:assert/strict';
import test from 'node:test';
import { insertIllustrationMarkdown, parseIllustrationPlan, buildSectionImagePrompt } from './illustrationPipeline';

test('配图规划解析：过滤非法/重复 ID，上限截断', () => {
  const payload = { illustrations: [
    { item_id: '1', prompt: '流程图' },
    { item_id: '1', prompt: '重复' },
    { item_id: '99', prompt: '非法 ID' },
    { item_id: '2', prompt: '架构图' },
    { item_id: '3', prompt: '超限' },
  ] };
  const plan = parseIllustrationPlan(payload, new Set(['1', '2', '3']), 2);
  assert.deepEqual(plan.map((item) => item.item_id), ['1', '2']);
});

test('插图插入：置于首段之后', () => {
  const content = '第一段内容。\n\n第二段内容。';
  const out = insertIllustrationMarkdown(content, '![配图](images/illustration/a.png)');
  assert.equal(out, '第一段内容。\n\n![配图](images/illustration/a.png)\n\n第二段内容。');
});

test('插图插入：空正文直接前置', () => {
  assert.equal(insertIllustrationMarkdown('', '![配图](a.png)'), '![配图](a.png)\n');
});

test('生图提示词：包含章节与场景并禁止文字', () => {
  const prompt = buildSectionImagePrompt('系统部署方案', '三节点集群部署拓扑');
  assert.ok(prompt.includes('系统部署方案'));
  assert.ok(prompt.includes('三节点集群部署拓扑'));
  assert.ok(prompt.includes('不要出现任何文字'));
});
