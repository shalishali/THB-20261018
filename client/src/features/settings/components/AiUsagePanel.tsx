import { useCallback, useEffect, useState } from 'react';
import { aiUsageStatsApi, type AiUsageSummary } from '../../../shared/api/stats';

// FE-17：个人 AI 调用记录面板（一期仅展示，不做扣费）。
// 数据源 GET /api/stats/ai-usage（API-13，只含本人记录）。

const BIZ_LABEL: Record<string, string> = {
  generate: '内容生成',
  expand: '内容扩写',
  'quality-check': '质检分析',
  analyze: '文件解析',
};

const RANGE_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} k`;
  return String(Math.round(value));
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function bizLabel(bizType: string): string {
  return BIZ_LABEL[bizType] || bizType || '其他';
}

export function AiUsagePanel() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextDays: number, nextPage: number) => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await aiUsageStatsApi.list({ days: nextDays, page: nextPage, pageSize: 20 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取调用统计失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days, page); }, [load, days, page]);

  const totalPages = summary ? Math.max(1, Math.ceil(summary.totalRows / summary.pageSize)) : 1;
  const buckets = summary ? Object.entries(summary.byBizType) : [];

  return (
    <section className="settings-page-section ai-usage-panel">
      <div className="settings-section-title"><span /><strong>AI 调用统计</strong></div>

      <div className="ai-diagnostics-hero">
        <div className="ai-diagnostics-statbar" role="group" aria-label="统计时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.days}
              type="button"
              className={`inline-action${days === option.days ? ' is-active' : ''}`}
              aria-pressed={days === option.days}
              onClick={() => { setDays(option.days); setPage(1); }}
            >
              {option.label}
            </button>
          ))}
          <button type="button" className="inline-action" onClick={() => void load(days, page)}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <p>一期仅统计展示，不扣费不限流。统计范围：内容生成 / 扩写 / 质检 / 解析等所有 AI 调用。</p>
      </div>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      {summary && (
        <>
          <div className="ai-diagnostics-statbar">
            <span><strong>{formatNumber(summary.totals.calls)}</strong> 调用次数</span>
            <span><strong>{formatNumber(summary.totals.inputChars)}</strong> 输入字数</span>
            <span><strong>{formatNumber(summary.totals.outputChars)}</strong> 输出字数</span>
            <span><strong>{formatNumber(summary.totals.inputTokens)}</strong> 输入 Token</span>
            <span><strong>{formatNumber(summary.totals.outputTokens)}</strong> 输出 Token</span>
          </div>

          {buckets.length > 0 && (
            <div className="ai-diagnostics-statbar">
              {buckets.map(([bizType, bucket]) => (
                <span key={bizType}>{bizLabel(bizType)}：<strong>{formatNumber(bucket.calls)}</strong> 次 · 出 <strong>{formatNumber(bucket.outputChars)}</strong> 字</span>
              ))}
            </div>
          )}

          <div className="ai-diagnostics-grid">
            <div className="ai-diagnostics-list">
              <div className="ai-diagnostics-list-head">
                <strong>最近调用明细（共 {summary.totalRows} 条）</strong>
                <span>
                  <button type="button" className="inline-action" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                  {' '}
                  <button type="button" className="inline-action" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
                  {' '}{page} / {totalPages}
                </span>
              </div>

              {summary.items.length === 0 && !loading && (
                <p className="ai-usage-empty">当前时间范围内暂无调用记录。完成一次生成 / 解析 / 质检后即可看到统计。</p>
              )}

              {summary.items.map((item) => (
                <article key={item.id} className="ai-diagnostic-attempt is-neutral">
                  <div className="ai-diagnostic-attempt-head">
                    <strong>{bizLabel(item.bizType)}</strong>
                    <span>{formatDate(item.createdAt)}</span>
                  </div>
                  <div className="ai-diagnostic-attempt-metrics">
                    <span>{item.model || item.provider || '未知模型'}</span>
                    <span>输入 {formatNumber(item.inputChars)} 字 / {formatNumber(item.inputTokens)} tok</span>
                    <span>输出 {formatNumber(item.outputChars)} 字 / {formatNumber(item.outputTokens)} tok</span>
                    {item.projectId != null && <span>项目 #{item.projectId}</span>}
                    {item.callCount > 1 && <span>×{item.callCount}</span>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
