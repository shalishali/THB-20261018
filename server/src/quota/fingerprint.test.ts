import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

const { buildExportContentFingerprint, buildLegacyExportFingerprints, isExportAlreadyBilled } = await import('./service');

const content = '# 标题\n\n正文内容。';
const outline = [{ content }];
const contentsJson = JSON.stringify([content]);
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// 回归：指纹曾把字数也纳入哈希，字数口径一调整（围栏代码块计入计费）同一内容就变成"新内容"，
// 导致重复导出再次扣费。现在指纹必须只由内容决定。
test('导出指纹只由内容决定，与字数口径无关', () => {
  assert.equal(buildExportContentFingerprint(outline), sha(contentsJson));
});

test('旧指纹候选包含「字数:内容」历史格式', () => {
  const candidates = buildLegacyExportFingerprints(outline, 6);
  assert.ok(candidates.includes(sha(`6:${contentsJson}`)), '应包含当前口径字数旧格式');
  assert.ok(candidates.includes(sha(`0:${contentsJson}`)) || candidates.length >= 2);
});

test('旧流水命中即视为已计费（去重查询按候选指纹 in 匹配）', async () => {
  let captured: unknown = null;
  const prisma = {
    quotaConsumeLog: {
      findFirst: async (args: unknown) => {
        captured = args;
        return { id: 1 };
      },
    },
  };
  const billed = await isExportAlreadyBilled(prisma as never, 7, ['fp-new', 'fp-legacy']);
  assert.equal(billed, true);
  assert.deepEqual((captured as { where: unknown }).where, { userId: 7, fingerprint: { in: ['fp-new', 'fp-legacy'] } });
});

test('无流水时返回未计费', async () => {
  const prisma = { quotaConsumeLog: { findFirst: async () => null } };
  assert.equal(await isExportAlreadyBilled(prisma as never, 7, ['fp']), false);
});
