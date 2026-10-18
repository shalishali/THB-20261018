// AI 质检免责声明横幅（FE-12）：
// 废标项检查 / 标书查重等 AI 检查结果仅作辅助提示，不能替代人工审核。
// 投标文件出现废标风险属于重大商业后果，产品侧必须显著提示（product_mvp 风险清单第 9 条）。
export function AiCheckDisclaimer() {
  return (
    <div className="ai-disclaimer-banner" role="note">
      <strong>AI 辅助提示</strong>
      <span>AI 检查结果仅供参考，可能存在遗漏或误判，不能替代人工审核；正式投标前请务必逐条人工复核。</span>
    </div>
  );
}
