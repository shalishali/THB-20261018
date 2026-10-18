// 自动配图（插图）管线：规划（哪些小节适合配图 + 场景描述）→ 生图 → 插入正文。
// 移植自桌面版插图阶段（个人版曾裁剪，2026-10 恢复，简化为 AI 规划 + 生图两步）。
// 约束：商业扁平插画风、图中禁止出现文字（生图模型文字渲染易乱码）、单文档上限由调用方控制。

export interface IllustrationPlanItem {
  item_id: string;
  title: string;
  prompt: string;
}

export const MAX_ILLUSTRATIONS_PER_DOCUMENT = 8;

export function buildIllustrationPlanMessages(
  sections: Array<{ id: string; title: string }>,
  maxImages: number,
): Array<{ role: 'system' | 'user'; content: string }> {
  const sectionList = sections
    .map((section) => `${section.id}|${section.title}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: `你是投标技术方案的配图编排助手。请从给定小节中挑选最适合配示意图的小节。

要求：
1. 只返回 JSON，不要输出解释或 Markdown。
2. 适合配图的内容：实施流程、系统架构、网络拓扑、组织架构、部署方案、时序交互、功能模块划分。
3. 不适合配图的：纯参数表、报价、职责清单、术语解释、风险条款等。
4. 最多挑选 ${maxImages} 个，宁缺毋滥；没有合适小节时返回空数组。
5. prompt 用一句中文描述这张图要表达的场面（例如"项目实施五阶段流程图，从需求调研到验收交付"），20-40 字，不要出现具体公司名与人名。`,
    },
    {
      role: 'user',
      content: `候选小节（格式：ID|标题）：\n${sectionList}\n\n请返回配图编排 JSON：\n\n{\n  "illustrations": [\n    { "item_id": "小节ID", "prompt": "这张示意图要表达什么" }\n  ]\n}`,
    },
  ];
}

export function parseIllustrationPlan(
  payload: unknown,
  validIds: Set<string>,
  maxImages: number,
): IllustrationPlanItem[] {
  const source = payload as { illustrations?: unknown } | null;
  const list = Array.isArray(source?.illustrations) ? source.illustrations : [];
  const seen = new Set<string>();
  const result: IllustrationPlanItem[] = [];
  for (const item of list) {
    const itemId = String((item as { item_id?: unknown })?.item_id || '').trim();
    const prompt = String((item as { prompt?: unknown })?.prompt || '').trim();
    if (!itemId || !validIds.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    result.push({
      item_id: itemId,
      title: '',
      prompt: prompt.slice(0, 200),
    });
    if (result.length >= maxImages) break;
  }
  return result;
}

export function buildSectionImagePrompt(title: string, scenePrompt: string): string {
  return [
    `为投标技术方案绘制一张商务扁平风示意图，主题：${scenePrompt}。`,
    `相关章节：${title}。`,
    '要求：简洁专业、蓝色系配色、矢量扁平插画风格；图中不要出现任何文字、字母、数字或水印；不要使用照片写实风格。',
  ].join('');
}

/** 把图片 Markdown 插入正文第一个段落之后（空正文则直接前置）。 */
export function insertIllustrationMarkdown(content: string, markdown: string): string {
  const text = String(content || '');
  if (!text.trim()) return `${markdown}\n`;
  const paragraphs = text.split(/\n{2,}/);
  const first = paragraphs.shift() ?? '';
  return [first, markdown, ...paragraphs].filter((part) => part !== undefined).join('\n\n');
}
