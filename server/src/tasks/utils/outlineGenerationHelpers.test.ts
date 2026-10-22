import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeMirrorProcurement,
  extractRequirementGroupsMessagesForTest,
  filterTechnicalRequirementGroups,
  distributeOutlineLeavesForTest,
  normalizeTechnicalRequirementGroupTitle,
  childrenOutlineFixedStructureRules,
  validateCompleteOutline,
  propagateOutlineRequirementSources,
  formatReviewSuggestion,
  normalizeReviewResponse,
  type OutlinePayload,
} from './outlineGenerationHelpers';

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

test('技术方案独立成册：评分大类提取提示词只保留技术评分项并要求 category', () => {
  const messages = extractRequirementGroupsMessagesForTest({
    overview: '项目概述',
    requirements: '## 技术评分项\n1. 服务方案 20分',
    oldOutline: undefined,
    wordControlInstruction: '最少字数：100000 字',
  }, null, true);
  const prompt = messages.map((message) => String(message.content || '')).join('\n');
  assert.match(prompt, /技术文件独立成册/);
  assert.match(prompt, /供应商实力、业绩、商务\/资信/);
  assert.match(prompt, /"category": "technical"/);
  assert.match(prompt, /不得创建“技术方案”/);
});

test('技术方案独立成册：过滤商务/资信、业绩等非技术评分项', () => {
  const groups = [
    { requirement_id: 'R1', title: '服务方案', description: '技术方案', detail_points: [], category: 'technical' as const },
    { requirement_id: 'R2', title: '供应商实力', description: '商务资信', detail_points: [], category: 'business' as const },
    { requirement_id: 'R3', title: '业绩', description: '业绩证明', detail_points: [], category: 'qualification' as const },
    { requirement_id: 'R4', title: '质量保障措施', description: '技术', detail_points: [] },
    { requirement_id: 'R5', title: '服务要求响应', description: '响应条款', detail_points: [], category: 'technical' as const },
  ];
  const kept = filterTechnicalRequirementGroups(groups);
  assert.deepEqual(kept.map((group) => group.requirement_id), ['R1', 'R4']);
});

test('评分项标题去掉末尾「（方案）」泛化后缀', () => {
  assert.equal(normalizeTechnicalRequirementGroupTitle('项目实施（方案）'), '项目实施');
  assert.equal(normalizeTechnicalRequirementGroupTitle('项目实施(方案)'), '项目实施');
  assert.equal(normalizeTechnicalRequirementGroupTitle(' 项目实施（方案） '), '项目实施');
  assert.equal(normalizeTechnicalRequirementGroupTitle('培训方案'), '培训方案');
  assert.equal(normalizeTechnicalRequirementGroupTitle('项目实施（暗标）'), '项目实施（暗标）');
});

test('生成前叶子配额：总数等于目标、每组至少 2 个、按权重倾斜', () => {
  const groups = [
    { requirement_id: 'R1' },
    { requirement_id: 'R2' },
    { requirement_id: 'R3' },
  ];
  const allocation = distributeOutlineLeavesForTest(groups, { R1: 1, R2: 2, R3: 1 }, 12);
  const total = Object.values(allocation).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 12);
  Object.values(allocation).forEach((value) => assert.ok(value >= 2));
  assert.ok(allocation.R2 >= allocation.R1);
  // 目标小于最小组数时自动抬到每组 2 个
  const minimal = distributeOutlineLeavesForTest(groups, { R1: 1, R2: 1, R3: 1 }, 1);
  assert.equal(Object.values(minimal).reduce((sum, value) => sum + value, 0), 6);
});

test('目录结构：允许两级、非叶子节点必须至少两个子节点', () => {
  const twoLevel: OutlinePayload = {
    outline: [
      {
        id: '1',
        title: '服务方案',
        description: '说明',
        children: [
          { id: '1.1', title: '实施方案', description: '说明' },
          { id: '1.2', title: '服务保障', description: '说明' },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => validateCompleteOutline(twoLevel));

  const singleChild: OutlinePayload = {
    outline: [
      {
        id: '1',
        title: '服务方案',
        description: '说明',
        children: [{ id: '1.1', title: '实施方案', description: '说明' }],
      },
    ],
  };
  assert.throws(() => validateCompleteOutline(singleChild), /不能只有一个子目录/);

  const onlyRoot: OutlinePayload = {
    outline: [{ id: '1', title: '服务方案', description: '说明' }],
  };
  assert.throws(() => validateCompleteOutline(onlyRoot), /至少需要两级/);
});

test('目录结构规则禁止无评分项来源的通用章节；二级可作为叶子', () => {
  const rules = childrenOutlineFixedStructureRules();
  assert.match(rules, /至少 2 个/);
  assert.match(rules, /项目理解/);
  assert.match(rules, /编制说明/);
  assert.match(rules, /也可以直接作为叶子/);
});

test('目录来源映射：一级目录评分项来源会下推到所有后代', () => {
  const source: OutlinePayload = {
    outline: [
      {
        id: '1',
        title: '服务方案',
        description: '说明',
        source_requirement_id: 'R1',
        source_requirement_title: '服务方案',
        children: [
          {
            id: '1.1',
            title: '实施方案',
            description: '说明',
            children: [
              { id: '1.1.1', title: '实施要点', description: '说明' },
              { id: '1.1.2', title: '保障措施', description: '说明' },
            ],
          },
          { id: '1.2', title: '服务保障', description: '说明' },
        ],
      },
    ],
  };
  const propagated = propagateOutlineRequirementSources(source);
  const root = propagated.outline![0];
  assert.equal(root.source_requirement_id, 'R1');
  assert.equal(root.children![0].source_requirement_title, '服务方案');
  assert.equal(root.children![0].children![0].source_requirement_id, 'R1');
  assert.equal(root.children![1].source_requirement_title, '服务方案');
});

test('最终审核 suggestions 对象会格式化为可读文本，不再出现 [object Object]', () => {
  assert.equal(
    formatReviewSuggestion({ title: '目录结构', description: '二级目录下只有一个小节' }),
    '目录结构：二级目录下只有一个小节',
  );
  assert.equal(
    formatReviewSuggestion({ issue: '缺少评分项映射', suggestion: '补充与评分项的对应关系' }),
    '缺少评分项映射：补充与评分项的对应关系',
  );
  assert.equal(formatReviewSuggestion(' 结构需要优化 '), '结构需要优化');
  const fallback = formatReviewSuggestion({ foo: 'bar' });
  assert.match(fallback, /foo/);
  assert.doesNotMatch(fallback, /\[object Object\]/);
  assert.equal(formatReviewSuggestion(null), '');
  assert.equal(formatReviewSuggestion(''), '');
});

test('最终审核响应兼容字符串数组、对象数组和单个对象', () => {
  const fromObjects = normalizeReviewResponse({
    passed: false,
    suggestions: [
      { title: '重复目录', description: '删除重复的“项目理解”' },
      { issue: '层级过深', suggestion: '合并三级目录' },
    ],
  });
  assert.deepEqual(fromObjects.suggestions, ['重复目录：删除重复的“项目理解”', '层级过深：合并三级目录']);
  assert.ok(fromObjects.suggestions.every((item) => !item.includes('[object Object]')));

  const single = normalizeReviewResponse({ passed: false, suggestions: { description: '目录缺少来源映射' } });
  assert.deepEqual(single.suggestions, ['目录缺少来源映射']);
});
