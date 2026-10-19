import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bizTypeFromTaskType,
  countMessagesChars,
  normalizeBizType,
  recordAiUsage,
  recordAgentAiUsageByProject,
} from './usageStats';

test('normalizeBizType 仅放行白名单，其余归一为 generate', () => {
  assert.equal(normalizeBizType('generate'), 'generate');
  assert.equal(normalizeBizType('expand'), 'expand');
  assert.equal(normalizeBizType('quality-check'), 'quality-check');
  assert.equal(normalizeBizType('analyze'), 'analyze');
  assert.equal(normalizeBizType('image'), 'image');
  assert.equal(normalizeBizType('hack-biz'), 'generate');
  assert.equal(normalizeBizType(''), 'generate');
  assert.equal(normalizeBizType(undefined), 'generate');
  assert.equal(normalizeBizType(null), 'generate');
});

test('bizTypeFromTaskType 任务类型映射业务类型', () => {
  assert.equal(bizTypeFromTaskType('outline-generation'), 'generate');
  assert.equal(bizTypeFromTaskType('content-generation'), 'generate');
  assert.equal(bizTypeFromTaskType('global-facts-generation'), 'generate');
  assert.equal(bizTypeFromTaskType('bid-analysis'), 'analyze');
  assert.equal(bizTypeFromTaskType('bid-section-extraction'), 'analyze');
  assert.equal(bizTypeFromTaskType('duplicate-analysis'), 'quality-check');
  assert.equal(bizTypeFromTaskType('rejection-check-run'), 'quality-check');
  assert.equal(bizTypeFromTaskType('rejection-items-extraction'), 'quality-check');
  assert.equal(bizTypeFromTaskType('unknown-task'), 'generate');
});

test('countMessagesChars 统计 string 与多模态 content 字数', () => {
  assert.equal(countMessagesChars([
    { role: 'user', content: '12345' },
    { role: 'assistant', content: 'ab' },
  ]), 7);
  assert.equal(countMessagesChars([
    { role: 'user', content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙丙' }] },
  ]), 3);
  assert.equal(countMessagesChars([]), 0);
  assert.equal(countMessagesChars(undefined), 0);
  assert.equal(countMessagesChars(null), 0);
  assert.equal(countMessagesChars([{ role: 'user' }]), 0);
  assert.equal(countMessagesChars([{ role: 'user', content: [{ type: 'image_url' }] }]), 0);
});

function makePrismaMock(overrides: Partial<{ createError: unknown }> = {}) {
  const created: unknown[] = [];
  return {
    created,
    prisma: {
      aiCallStat: {
        create: async (args: unknown) => {
          if (overrides.createError) throw overrides.createError;
          created.push(args);
          return {};
        },
      },
      project: {
        findUnique: async ({ where }: { where: { id: number } }) =>
          where.id === 77 ? { ownerId: 9 } : null,
      },
    } as never,
  };
}

test('recordAiUsage 落库字段完整且数值安全', async () => {
  const { prisma, created } = makePrismaMock();
  const ok = await recordAiUsage(prisma, {
    userId: 7,
    projectId: 3,
    provider: 'deepseek',
    model: 'deepseek-chat',
    bizType: 'analyze',
    inputTokens: 100.6,
    outputTokens: -5,
    inputChars: 20,
    outputChars: 30,
  });
  assert.equal(ok, true);
  assert.equal(created.length, 1);
  const data = (created[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.userId, 7);
  assert.equal(data.projectId, 3);
  assert.equal(data.bizType, 'analyze');
  assert.equal(data.callCount, 1);
  assert.equal(data.inputTokens, 101); // 四舍五入
  assert.equal(data.outputTokens, 0); // 负数归零
});

test('recordAiUsage 对非法输入与落库异常均安全返回 false', async () => {
  const { prisma } = makePrismaMock({ createError: new Error('db down') });
  assert.equal(await recordAiUsage(null, { userId: 1 }), false);
  assert.equal(await recordAiUsage(prisma, { userId: 0 }), false);
  assert.equal(await recordAiUsage(prisma, { userId: -1 }), false);
  assert.equal(await recordAiUsage(prisma, { userId: Number.NaN }), false);
  assert.equal(await recordAiUsage(prisma, { userId: 5 }), false); // create 抛错被吞
});

test('recordAgentAiUsageByProject 反查 owner 后落库；项目不存在则不落库', async () => {
  const { prisma, created } = makePrismaMock();
  assert.equal(await recordAgentAiUsageByProject(prisma, 77, { model: 'glm-4', bizType: 'generate' }), true);
  assert.equal(created.length, 1);
  assert.equal((created[0] as { data: { userId: number; projectId: number } }).data.userId, 9);
  assert.equal((created[0] as { data: { userId: number; projectId: number } }).data.projectId, 77);
  // 不存在的项目：反查 miss → 不落库。
  assert.equal(await recordAgentAiUsageByProject(prisma, 404, { model: 'glm-4' }), false);
  assert.equal(created.length, 1);
  // 非法 projectId（undefined/null）直接短路。
  assert.equal(await recordAgentAiUsageByProject(prisma, undefined, {}), false);
  assert.equal(await recordAgentAiUsageByProject(null, 77, {}), false);
});
