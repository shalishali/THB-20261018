import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeOutlineLeafTarget,
  countOutlineLeafNodes,
  checkOutlineLeafBudget,
} from './outlineGenerationHelpers';
import { deriveSectionGuidanceWords, buildSectionWordRequirement } from './contentGenerationHelpers';

// A：字数预设 → 目标叶子数（与 STEP03 字数指令同源同公式）
test('computeOutlineLeafTarget：3~3.6 万字未设每小节字数 → 约 11 节', () => {
  assert.equal(computeOutlineLeafTarget({ minWordsWan: 3, maxWordsWan: 3.6 }), 11);
});

test('computeOutlineLeafTarget：设置每小节字数后按实际值折算', () => {
  assert.equal(computeOutlineLeafTarget({ minWordsWan: 3, maxWordsWan: 3.6, wordsPerSectionWan: 0.2 }), 17);
});

test('computeOutlineLeafTarget：仅上限/仅下限/全空', () => {
  assert.equal(computeOutlineLeafTarget({ maxWordsWan: 3.6 }), 10);
  assert.equal(computeOutlineLeafTarget({ minWordsWan: 3 }), 12);
  assert.equal(computeOutlineLeafTarget(undefined), 0);
  assert.equal(computeOutlineLeafTarget({}), 0);
});

test('countOutlineLeafNodes：只统计无 children 的节点', () => {
  const tree = [
    { title: '一', children: [
      { title: '1.1', children: [{ title: '1.1.1' }, { title: '1.1.2' }] },
      { title: '1.2' },
    ] },
    { title: '二' },
  ];
  assert.equal(countOutlineLeafNodes(tree), 4);
  assert.equal(countOutlineLeafNodes([]), 0);
  assert.equal(countOutlineLeafNodes(undefined), 0);
});

test('checkOutlineLeafBudget：52 节超 11 节预算被拦截，17 节以内放行', () => {
  const options = { minWordsWan: 3, maxWordsWan: 3.6 };
  const budget52 = checkOutlineLeafBudget(new Array(52), options);
  assert.equal(budget52.target, 11);
  assert.equal(budget52.limit, 17); // max(11+4, ceil(11*1.5))
  assert.equal(budget52.ok, false);

  assert.equal(checkOutlineLeafBudget(new Array(17), options).ok, true);

  // 未设置字数预设时不校验
  assert.equal(checkOutlineLeafBudget(new Array(99), undefined).ok, true);
});

// B：小节数超预算时单节目标自动摊分
function snapshot(partial: Record<string, unknown>) {
  return {
    enabled: true,
    minimumWords: 0,
    maximumWords: 0,
    sectionWords: 0,
    strictSectionWords: false,
    sectionMinimumWords: 0,
    sectionMaximumWords: 0,
    ...partial,
  } as any;
}

test('deriveSectionGuidanceWords：3.3 万中位 ÷ 52 节 ≈ 634 字', () => {
  const wc = snapshot({ minimumWords: 30000, maximumWords: 36000 });
  assert.equal(deriveSectionGuidanceWords(wc, 52), 634);
});

test('deriveSectionGuidanceWords：摊分值低于 600 字下限按 600 计', () => {
  const wc = snapshot({ minimumWords: 30000, maximumWords: 36000 });
  assert.equal(deriveSectionGuidanceWords(wc, 100), 600);
});

test('deriveSectionGuidanceWords：显式小节字数作为上限收敛', () => {
  const wc = snapshot({ minimumWords: 30000, maximumWords: 36000, sectionWords: 2000, sectionMinimumWords: 1600, sectionMaximumWords: 2400 });
  // 摊分 634 < 2000 → 取 634；小节数少摊分值高时不超过显式设置
  assert.equal(deriveSectionGuidanceWords(wc, 52), 634);
  assert.equal(deriveSectionGuidanceWords(wc, 5), 2000);
});

test('deriveSectionGuidanceWords：无字数预算时不摊分', () => {
  assert.equal(deriveSectionGuidanceWords(snapshot({}), 52), 0);
});

test('buildSectionWordRequirement：摊分模式下也下达字数要求', () => {
  const wc = snapshot({ minimumWords: 30000, maximumWords: 36000 });
  assert.equal(buildSectionWordRequirement(wc, false, 0), '');
  const text = buildSectionWordRequirement(wc, false, 634);
  assert.ok(text.includes('634'));
  assert.ok(text.includes('自动摊分'));
});
