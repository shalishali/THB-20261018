// 前端字数展示口径（与后端 server/src/utils/textCount.ts 的 countReadableChars 完全一致）。
// 任何改动都必须两边同步，否则会出现「页面显示 114,198 / 实际扣费 115,017」这类对不齐的问题。
//
// 口径：剥离 Markdown 语法（图片整段、链接保留文字、标题/列表/引用符号、行内代码标记、
// 表格竖线、水平线），**不剔除围栏代码块**（导出时围栏内容会渲染进 Word），去空白后逐字符计数
// （含标点、英文字母、数字）。
function stripMarkdown(content: string): string {
  return String(content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)．、]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\|/g, '')
    .replace(/[-=]{3,}/g, '');
}

export function countReadableWords(content: string): number {
  return stripMarkdown(content).replace(/\s/g, '').length;
}

// 兼容旧调用：返回剥离 Markdown 后、空白压缩的可读文本。
// 注意：展示字数请用 countReadableWords（与服务端计费同口径）。
export function normalizeReadableText(content: string): string {
  return stripMarkdown(content).replace(/\s+/g, ' ').trim();
}
