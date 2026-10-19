import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentService } from '../../agent/types';
import {
  runFinalOutlineGate,
  type OutlineAiService,
  type OutlinePayload,
  type RequirementGroup,
} from './outlineGenerationHelpers';

function buildGroups(): RequirementGroup[] {
  return [{ requirement_id: 'R1', title: '服务方案', description: '技术方案', detail_points: ['实施要点'] }];
}

function buildOutline(leafCount: number): OutlinePayload {
  const leaves = Array.from({ length: leafCount }, (_, index) => ({
    id: `1.1.${index + 1}`,
    title: `要点 ${index + 1}`,
    description: '说明',
  }));
  return {
    outline: [
      {
        id: '1',
        title: '服务方案',
        description: '技术方案',
        source_requirement_id: 'R1',
        children: [{ id: '1.1', title: '实施方案', description: '说明', children: leaves }],
      },
    ],
  };
}

function buildMergedOutline(): OutlinePayload {
  return {
    outline: [
      {
        id: '1',
        title: '服务方案',
        description: '技术方案',
        source_requirement_id: 'R1',
        children: [
          { id: '1.1', title: '实施方案', description: '说明', children: [{ id: '1.1.1', title: '实施要点', description: '说明' }, { id: '1.1.2', title: '保障措施', description: '说明' }] },
          { id: '1.2', title: '服务保障', description: '说明', children: [{ id: '1.2.1', title: '响应机制', description: '说明' }, { id: '1.2.2', title: '质量保证', description: '说明' }] },
        ],
      },
    ],
  };
}

function buildAiService(): OutlineAiService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getConfig: () => ({}),
    collectJsonResponse: async (options: Record<string, unknown>) => {
      const messages = Array.isArray(options.messages) ? options.messages as Array<{ content?: string }> : [];
      const text = messages.map((message) => String(message.content || '')).join('\n');
      calls.push(text.slice(0, 40));
      if (text.includes('最终目录审核')) return { passed: true, suggestions: [] };
      if (text.includes('叶子小节')) return buildMergedOutline();
      throw new Error(`unexpected ai call: ${text.slice(0, 80)}`);
    },
  };
}

function buildAgentService(optionId: string): AgentService & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    requestQuestion: async (payload: unknown) => {
      asked.push(payload);
      return { option_id: optionId };
    },
    runTask: async () => { throw new Error('测试中不应调用 Agent runTask'); },
  } as unknown as AgentService & { asked: unknown[] };
}

const wordOptions = { minWordsWan: 0.3, maxWordsWan: 0.6, wordsPerSectionWan: 0, forceSectionWords: false };

async function runGate(agentService: AgentService | undefined, outline: OutlinePayload) {
  const logMessages: string[] = [];
  const aiService = buildAiService();
  const result = await runFinalOutlineGate({
    aiService,
    agentService,
    payload: { outline_word_control_options: wordOptions },
    outline,
    groups: buildGroups(),
    originalOutline: null,
    workflowKind: 'technical-plan',
    outlineExpansionMode: 'ai-complement',
    log: (message: string) => { logMessages.push(String(message)); },
    projectId: 1,
    taskId: 'task-1',
  });
  return { result, logMessages, aiService };
}

test('叶子超预算：询问用户并选择自动合并，只调用一次普通模型合并（不再跑 Agent）', async () => {
  const agentService = buildAgentService('merge');
  const { result, aiService } = await runGate(agentService, buildOutline(20));
  const leaves = (result.outline.outline || []).flatMap((root) => (root.children || []).flatMap((child) => child.children || []));
  assert.equal(leaves.length, 4);
  assert.equal(agentService.asked.length, 1);
  const question = String((agentService.asked[0] as { question?: string }).question || '');
  assert.match(question, /叶子小节/);
  assert.ok(aiService.calls.length >= 2);
});

test('叶子超预算：用户接受当前结果时原样返回', async () => {
  const agentService = buildAgentService('accept');
  const original = buildOutline(20);
  const { result } = await runGate(agentService, original);
  assert.deepEqual(result.outline, original);
  assert.equal(agentService.asked.length, 1);
});

test('叶子超预算：Agent ask-user 不可用时软放行，不阻塞也不跑 Agent', async () => {
  const original = buildOutline(20);
  const { result, logMessages } = await runGate(undefined, original);
  assert.deepEqual(result.outline, original);
  assert.equal(logMessages.some((message) => message.includes('未收到叶子数量处理选择')), true);
});


