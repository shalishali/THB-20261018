// 全站唯一字数口径（供显示、字数预算校验、导出扣费共用）：
// 剥离 Markdown 语法与围栏代码块、去除全部空白后，逐字符计数（含标点、英文字母、数字）。
// 历史上显示（中文逐字/英文按词）与扣费（逐字符）是两套实现，同一文档相差可达 10%，
// 涉及付费属于事故级不一致——任何新的字数展示/统计必须引用本模块，不得另起炉灶。

export function countReadableChars(content: string): number {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, '\n')                  // 围栏代码块（Mermaid 等，不计费）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')              // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // 链接（保留文字）
    .replace(/^#{1,6}\s+/gm, '')                        // 标题符号
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                 // 加粗
    .replace(/(\*|_)(.*?)\1/g, '$2')                    // 斜体
    .replace(/^[-*+]\s+/gm, '')                         // 无序列表符号
    .replace(/^\d+[.)．、]\s+/gm, '')                   // 有序列表符号
    .replace(/^>\s+/gm, '')                             // 引用
    .replace(/`([^`]+)`/g, '$1')                        // 行内代码
    .replace(/\|/g, '')                                 // 表格分隔
    .replace(/[-=]{3,}/g, '')                           // 水平线/表格分隔线
    .replace(/\s/g, '')
    .length;
}

// 递归遍历大纲树（含全部子节点）按上述口径累计字数——与指纹（buildExportContentFingerprint）同源。
export function countOutlineContentChars(items: unknown): number {
  let sum = 0;
  const walk = (nodes: any[]): void => {
    for (const node of nodes || []) {
      const content = node?.content;
      if (typeof content === 'string') sum += countReadableChars(content);
      if (node?.children?.length) walk(node.children);
    }
  };
  walk(Array.isArray(items) ? (items as any[]) : []);
  return sum;
}

// ===== 测试（tsx --test 运行）=====
