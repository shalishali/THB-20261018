function stripFencedCodeBlocks(content: string) {
  return content.replace(/```[\s\S]*?```/g, '\n');
}

function stripMarkdownImages(content: string) {
  return content.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
}

function keepMarkdownLinkText(content: string) {
  return content
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
}

function stripUrls(content: string) {
  return content.replace(/\b(?:https?|file|yibiao-asset):\/\/\S+/gi, ' ');
}

function stripHtml(content: string) {
  return content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|tr|td|th|li|ul|ol|table|thead|tbody|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeMarkdownLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) return '';

  return line
    .replace(/^\s{0,3}#{1,6}\s+/g, ' ')
    .replace(/^\s{0,3}>\s?/g, ' ')
    .replace(/^\s*[-+*]\s+(?:\[[ xX]\]\s*)?/g, ' ')
    .replace(/^\s*\d+[.)．、]\s+/g, ' ')
    .replace(/^\s*\|/, ' ')
    .replace(/\|\s*$/g, ' ')
    .replace(/\|/g, ' ');
}

export function normalizeReadableText(content: string) {
  return stripHtml(stripUrls(keepMarkdownLinkText(stripMarkdownImages(stripFencedCodeBlocks(String(content || ''))))))
    .split(/\r?\n/)
    .map(normalizeMarkdownLine)
    .join('\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[~*_#>\[\](){}|\\]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countReadableWords(content: string) {
  // \u5b57\u6570\u53e3\u5f84\u5df2\u4e0e\u670d\u52a1\u7aef\u8ba1\u8d39\u7edf\u4e00\uff08utils/textCount \u540c\u89c4\u5219\uff09\uff1a\u5265 Markdown \u540e\u9010\u5b57\u7b26\u8ba1\u6570
  // \uff08\u542b\u6807\u70b9/\u5b57\u6bcd/\u6570\u5b57\uff09\uff0c\u7528\u6237\u770b\u5230\u7684\u5b57\u6570\u5373\u5bfc\u51fa\u6263\u8d39\u5b57\u6570\u3002\u6b64\u524d"\u82f1\u6587\u6309\u8bcd"\u7684\u53e3\u5f84\u4e0e\u6263\u8d39\u76f8\u5dee\u53ef\u8fbe 10%\u3002
  const readableText = normalizeReadableText(content);
  if (!readableText) return 0;
  return readableText.replace(/\s+/g, '').length;
}
