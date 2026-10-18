// API-12：AI 调用埋点落库（DB-12 AiCallStat，一期仅统计不扣费不限流）。
// 三条埋点链路共用本模块：
//  ① ai/service.ts 文本请求收口（recordTextTokenStats）：/ai/chat、/ai/request-json 与
//     tasks 引擎内一切直连 LLM 兜底调用——userId 经 config.__statUserId 打戳传入。
//  ② agent proxy 成功收口（aiProxy.ts recordOpenCodeAiSuccess → onUsage 回调）：
//     pi/opencode sidecar 的模型调用——userId 经 activeTask.project_id 反查项目 owner。
//  ③ 失败请求同样记一条（token/字数为 0），保证"每次请求"计数完整（API-12 措辞）。
// 所有落库 best-effort：失败仅 console.warn，绝不影响 AI 主流程。
import type { PrismaClient } from '@prisma/client';

export interface AiUsageRecordInput {
  userId: number;
  projectId?: number | null;
  provider?: string;
  model?: string;
  bizType?: string;
  callCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  inputChars?: number;
  outputChars?: number;
}

// 进程级 prisma 引用：ai/service.ts 与 agent runtime 深栈拿不到 Fastify app 实例，
// 由 server/src/index.ts 启动时注入（见 setUsageStatsPrisma 调用点）。
let statsPrisma: PrismaClient | null = null;

export function setUsageStatsPrisma(prisma: PrismaClient | null): void {
  statsPrisma = prisma;
}

export function getUsageStatsPrisma(): PrismaClient | null {
  return statsPrisma;
}

// bizType 白名单（对齐 DB-12 注释：generate 生成 / expand 扩写 / quality-check 质检 / analyze 解析）。
const BIZ_TYPES = new Set(['generate', 'expand', 'quality-check', 'analyze']);

export function normalizeBizType(raw: unknown): string {
  const value = String(raw ?? '').trim();
  return BIZ_TYPES.has(value) ? value : 'generate';
}

// tasks 引擎 task type → bizType 映射（wrapAiForRunner 打戳与 agent payload 归一化共用）。
const TASK_TYPE_BIZ: Record<string, string> = {
  'outline-generation': 'generate',
  'content-generation': 'generate',
  'global-facts-generation': 'generate',
  'bid-analysis': 'analyze',
  'bid-section-extraction': 'analyze',
  'duplicate-analysis': 'quality-check',
  'rejection-items-extraction': 'quality-check',
  'rejection-check-run': 'quality-check',
};

export function bizTypeFromTaskType(taskType: unknown): string {
  return TASK_TYPE_BIZ[String(taskType ?? '')] || 'generate';
}

function toNonNegativeInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

// OpenAI Chat messages 输入字数统计：string content 直算，多模态数组取各 part.text。
export function countMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === 'string') {
      total += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === 'string') total += text.length;
      }
    }
  }
  return total;
}

// 落库一条 AiCallStat。返回是否成功（仅供测试断言；调用方一律 fire-and-forget）。
export async function recordAiUsage(prisma: PrismaClient | null, input: AiUsageRecordInput): Promise<boolean> {
  if (!prisma) return false;
  const userId = Number(input.userId);
  if (!Number.isInteger(userId) || userId <= 0) return false;
  try {
    await (prisma as unknown as {
      aiCallStat: { create: (args: unknown) => Promise<unknown> };
    }).aiCallStat.create({
      data: {
        userId,
        projectId: typeof input.projectId === 'number' && Number.isFinite(input.projectId) ? input.projectId : null,
        provider: String(input.provider ?? ''),
        model: String(input.model ?? ''),
        bizType: normalizeBizType(input.bizType),
        callCount: Math.max(1, toNonNegativeInt(input.callCount) || 1),
        inputTokens: toNonNegativeInt(input.inputTokens),
        outputTokens: toNonNegativeInt(input.outputTokens),
        inputChars: toNonNegativeInt(input.inputChars),
        outputChars: toNonNegativeInt(input.outputChars),
      },
    });
    return true;
  } catch (error) {
    // 埋点 best-effort：落库失败仅告警，绝不抛回 AI 主流程。
    console.warn('[ai-usage-stats] AiCallStat 落库失败：', error instanceof Error ? error.message : error);
    return false;
  }
}

// projectId → ownerId 反查缓存（agent proxy 侧归属解析）。项目删除后的残留缓存无害：
// 仅用于统计归属，反查 miss 时本条不落库（宁可少记不可错记）。
const projectOwnerCache = new Map<number, number>();

// agent proxy 埋点入口：由 projectId 反查项目 owner 后落库。
export async function recordAgentAiUsageByProject(
  prisma: PrismaClient | null,
  projectId: number | null | undefined,
  info: Omit<AiUsageRecordInput, 'userId' | 'projectId'>,
): Promise<boolean> {
  if (!prisma || typeof projectId !== 'number' || !Number.isFinite(projectId)) return false;
  let ownerId = projectOwnerCache.get(projectId);
  if (ownerId == null) {
    const project = await (prisma as unknown as {
      project: { findUnique: (args: unknown) => Promise<{ ownerId: number } | null> };
    }).project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project?.ownerId) return false;
    ownerId = project.ownerId;
    projectOwnerCache.set(projectId, ownerId);
  }
  return recordAiUsage(prisma, { ...info, userId: ownerId, projectId });
}
