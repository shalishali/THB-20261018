import { useCallback, useEffect, useState } from 'react';
import { aiUsageStatsApi, type AiUsageSummary } from '../../../shared/api/stats';

// FE-17：个人 AI 调用记录面板（一期仅展示，不做扣费）。
// 数据源 GET /api/stats/ai-usage（API-13，只含本人记录）。

const BIZ_LABEL: Record<string, string> = {
  generate: '内容生成',
  expand: '内容扩写',
  'quality-check': '质检分析',
  analyze: '文件解析',
  image: '自动配图',
};

const RANGE_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

type PanelView = 'overview' | 'projects' | 'models' | 'providers' | 'detail';

const PANEL_VIEWS: Array<{ value: PanelView; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'projects', label: '按项目' },
  { value: 'models', label: '按模型' },
  { value: 'providers', label: '按服务商' },
  { value: 'detail', label: '调用明细' },
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
  const [view, setView] = useState<PanelView>('overview');
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
  const byProject = summary?.byProject ?? [];
  const byDay = summary?.byDay ?? [];
  const byModel = summary?.byModel ?? [];
  const byProvider = summary?.byProvider ?? [];
  const maxDayTokens = Math.max(...byDay.map((d) => d.inputTokens + d.outputTokens), 1);
  const totalTokens = (summary?.totals.inputTokens ?? 0) + (summary?.totals.outputTokens ?? 0);

  return (
    <section className="settings-page-section ai-usage-panel">
      <div className="settings-section-title"><span /><strong>AI 调用统计</strong></div>

      {/* 时间范围 + 刷新 */}
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
      </div>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      {summary && (
        <>
          {/* 汇总条 */}
          <div className="ai-diagnostics-statbar">
            <span><strong>{formatNumber(summary.totals.calls)}</strong> 调用次数</span>
            <span><strong>{formatNumber(summary.totals.inputTokens)}</strong> 输入 Token</span>
            <span><strong>{formatNumber(summary.totals.outputTokens)}</strong> 输出 Token</span>
            <span><strong>{formatNumber(summary.totals.inputChars)}</strong> 输入字数</span>
            <span><strong>{formatNumber(summary.totals.outputChars)}</strong> 输出字数</span>
          </div>

          {/* 子维度导航 */}
          <div className="ai-usage-subnav">
            {PANEL_VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                className={`ai-usage-subnav-btn${view === v.value ? ' is-active' : ''}`}
                onClick={() => setView(v.value)}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* ===== 概览 ===== */}
          {view === 'overview' && (
            <div className="ai-usage-view">
              <div className="ai-usage-kpi-row">
                <div className="ai-usage-kpi">
                  <span className="ai-usage-kpi-label">调用次数</span>
                  <span className="ai-usage-kpi-num">{formatNumber(summary.totals.calls)}</span>
                </div>
                <div className="ai-usage-kpi">
                  <span className="ai-usage-kpi-label">输入 Token</span>
                  <span className="ai-usage-kpi-num">{formatNumber(summary.totals.inputTokens)}</span>
                </div>
                <div className="ai-usage-kpi">
                  <span className="ai-usage-kpi-label">输出 Token</span>
                  <span className="ai-usage-kpi-num">{formatNumber(summary.totals.outputTokens)}</span>
                </div>
              </div>

              {byDay.length > 0 && (
                <>
                  <div className="ai-usage-sub-title">每日趋势</div>
                  <div className="ai-usage-day-trend">
                    {byDay.map((day) => {
                      const total = day.inputTokens + day.outputTokens;
                      const barW = Math.max(4, Math.round((total / maxDayTokens) * 100));
                      return (
                        <div key={day.date} className="ai-usage-day-row">
                          <span className="ai-usage-day-date">{day.date.slice(5)}</span>
                          <span className="ai-usage-day-bar-track">
                            <span className="ai-usage-day-bar" style={{ width: `${barW}%` }} />
                          </span>
                          <span className="ai-usage-day-num">{formatNumber(total)}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {byProject.length > 0 && (
                <>
                  <div className="ai-usage-sub-title">项目排行（Top 10）</div>
                  <div className="ai-usage-table-wrap">
                    <table className="ai-usage-table">
                      <thead>
                        <tr><th>项目</th><th>调用</th><th>文本 tok</th><th>生图 tok</th><th>合计 tok</th></tr>
                      </thead>
                      <tbody>
                        {byProject.slice(0, 10).map((proj) => (
                          <tr key={proj.projectId}>
                            <td>{proj.projectName}</td>
                            <td>{proj.calls}</td>
                            <td>{formatNumber(proj.textTokens)}</td>
                            <td>{formatNumber(proj.imageTokens)}</td>
                            <td>{formatNumber(proj.inputTokens + proj.outputTokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="settings-pricing-actions" style={{ marginTop: 12 }}>
                <span className="settings-pricing-hint">一期仅统计展示，不扣费不限流。配图等生成行为不在计费范围。</span>
              </div>
            </div>
          )}

          {/* ===== 按项目 ===== */}
          {view === 'projects' && (
            <div className="ai-usage-view">
              {byProject.length === 0 ? (
                <p className="ai-usage-empty">暂无项目数据。</p>
              ) : (
                <div className="ai-usage-table-wrap">
                  <table className="ai-usage-table">
                    <thead>
                      <tr><th>项目</th><th>调用</th><th>文本 tok</th><th>生图 tok</th><th>合计 tok</th></tr>
                    </thead>
                    <tbody>
                      {byProject.map((proj) => (
                        <tr key={proj.projectId}>
                          <td>{proj.projectName}</td>
                          <td>{proj.calls}</td>
                          <td>{formatNumber(proj.textTokens)}</td>
                          <td>{formatNumber(proj.imageTokens)}</td>
                          <td>{formatNumber(proj.inputTokens + proj.outputTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ===== 按模型 ===== */}
          {view === 'models' && (
            <div className="ai-usage-view">
              {byModel.length === 0 ? (
                <p className="ai-usage-empty">暂无模型数据。</p>
              ) : (
                <div className="ai-usage-table-wrap">
                  <table className="ai-usage-table">
                    <thead>
                      <tr><th>模型</th><th>调用</th><th>输入 tok</th><th>输出 tok</th><th>合计 tok</th></tr>
                    </thead>
                    <tbody>
                      {byModel.map((m) => (
                        <tr key={m.key}>
                          <td>{m.label}</td>
                          <td>{m.calls}</td>
                          <td>{formatNumber(m.inputTokens)}</td>
                          <td>{formatNumber(m.outputTokens)}</td>
                          <td>{formatNumber(m.inputTokens + m.outputTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ===== 按服务商 ===== */}
          {view === 'providers' && (
            <div className="ai-usage-view">
              {byProvider.length === 0 ? (
                <p className="ai-usage-empty">暂无服务商数据。</p>
              ) : (
                <div className="ai-usage-table-wrap">
                  <table className="ai-usage-table">
                    <thead>
                      <tr><th>服务商</th><th>调用</th><th>输入 tok</th><th>输出 tok</th><th>合计 tok</th></tr>
                    </thead>
                    <tbody>
                      {byProvider.map((p) => (
                        <tr key={p.key}>
                          <td>{p.label}</td>
                          <td>{p.calls}</td>
                          <td>{formatNumber(p.inputTokens)}</td>
                          <td>{formatNumber(p.outputTokens)}</td>
                          <td>{formatNumber(p.inputTokens + p.outputTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ===== 调用明细 ===== */}
          {view === 'detail' && (
            <div className="ai-usage-view">
              <div className="ai-usage-table-wrap">
                <table className="ai-usage-table">
                  <thead>
                    <tr><th>类型</th><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>项目</th></tr>
                  </thead>
                  <tbody>
                    {summary.items.map((item) => (
                      <tr key={item.id}>
                        <td>{bizLabel(item.bizType)}</td>
                        <td>{formatDate(item.createdAt)}</td>
                        <td>{item.model || item.provider || '-'}</td>
                        <td>{formatNumber(item.inputChars)} 字 / {formatNumber(item.inputTokens)} tok</td>
                        <td>{formatNumber(item.outputChars)} 字 / {formatNumber(item.outputTokens)} tok</td>
                        <td>{item.projectId != null ? `#${item.projectId}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid #e6eaf2' }}>
                  <button type="button" className="inline-action" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                  <span style={{ fontSize: 12, color: '#64748b' }}>{page} / {totalPages} 页（共 {summary.totalRows} 条）</span>
                  <button type="button" className="inline-action" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
