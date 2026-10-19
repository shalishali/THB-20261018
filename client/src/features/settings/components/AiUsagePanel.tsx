import { useCallback, useEffect, useMemo, useState } from 'react';
import { aiUsageStatsApi, type AiUsageProjectBucket, type AiUsageSummary } from '../../../shared/api/stats';

// FE-17：AI 调用统计面板。
// 数据源 GET /api/stats/ai-usage：普通用户只看本人；管理员看全站（含「按用户」维度）。
// 展示口径：token 用精确数字（千分位），不做「万/k」缩略；日趋势保留缩略避免撑破布局。

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

type PanelView = 'overview' | 'projects' | 'users' | 'models' | 'providers' | 'detail';

const PANEL_VIEWS: Array<{ value: PanelView; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'projects', label: '按项目' },
  { value: 'users', label: '按用户' },
  { value: 'models', label: '按模型' },
  { value: 'providers', label: '按服务商' },
  { value: 'detail', label: '调用明细' },
];

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} k`;
  return String(Math.round(value));
}

/** 精确整数（千分位）——token / 次数 / 字数都用这个，避免「8.1 万」看不出确切值。 */
function formatInt(value: number): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return Math.round(num).toLocaleString('zh-CN');
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function bizLabel(bizType: string): string {
  return BIZ_LABEL[bizType] || bizType || '其他';
}

function projectCodeLabel(proj: AiUsageProjectBucket): string {
  return proj.projectCode?.trim() || '—';
}

type ProjectRowProps = { proj: AiUsageProjectBucket; showOwner: boolean };

function ProjectRow({ proj, showOwner }: ProjectRowProps) {
  return (
    <tr>
      <td className="ai-usage-project-code">{projectCodeLabel(proj)}</td>
      <td className="ai-usage-project-name" title={proj.projectName}>
        {proj.projectName}
        {proj.projectDeleted && <span className="ai-usage-tag">已删除</span>}
      </td>
      {showOwner && <td>{proj.ownerName || '-'}</td>}
      <td className="ai-usage-num">{formatInt(proj.calls)}</td>
      <td className="ai-usage-num">{formatInt(proj.inputTokens)}</td>
      <td className="ai-usage-num">{formatInt(proj.outputTokens)}</td>
      <td className="ai-usage-num ai-usage-num-strong">{formatInt(proj.inputTokens + proj.outputTokens)}</td>
      <td className="ai-usage-num">{proj.imageCalls ? `${formatInt(proj.imageCalls)} 次` : '0'}</td>
    </tr>
  );
}

export function AiUsagePanel() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<PanelView>('overview');
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 筛选：userId 仅管理员可选；keyword 匹配项目名称/编号/ID；draft 与已生效值分开，回车/查询才触发。
  const [filterUserId, setFilterUserId] = useState<number | ''>('');
  const [keyword, setKeyword] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');

  const load = useCallback(async (nextDays: number, nextPage: number, nextUserId: number | '', nextKeyword: string) => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await aiUsageStatsApi.list({
        days: nextDays,
        page: nextPage,
        pageSize: 20,
        ...(nextUserId !== '' ? { userId: Number(nextUserId) } : {}),
        ...(nextKeyword.trim() ? { keyword: nextKeyword.trim() } : {}),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取调用统计失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days, page, filterUserId, keyword); }, [load, days, page, filterUserId, keyword]);

  const totalPages = summary ? Math.max(1, Math.ceil(summary.totalRows / summary.pageSize)) : 1;
  const isAdminView = summary?.scope === 'all';
  const byProject = summary?.byProject ?? [];
  const byUser = summary?.byUser ?? [];
  const byDay = summary?.byDay ?? [];
  const byModel = summary?.byModel ?? [];
  const byProvider = summary?.byProvider ?? [];
  const maxDayTokens = Math.max(...byDay.map((d) => d.inputTokens + d.outputTokens), 1);
  const views = useMemo(
    () => PANEL_VIEWS.filter((item) => item.value !== 'users' || isAdminView),
    [isAdminView],
  );

  // 管理员切到「按用户」时若权限被撤/接口变 self，回退到概览。
  useEffect(() => {
    if (view === 'users' && summary && summary.scope !== 'all') setView('overview');
  }, [summary, view]);

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
          <button type="button" className="inline-action" onClick={() => void load(days, page, filterUserId, keyword)}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      {summary && (
        <>
          <p className="ai-usage-scope-hint">
            {isAdminView
              ? '管理员视图：统计全部用户的 AI 调用（含项目编号/所属用户）；token 为模型返回的 usage 精确值。'
              : '当前仅统计你自己的 AI 调用。'}
            {loading ? ' 正在刷新…' : ''}
          </p>

          {/* 汇总卡片（精确数字） */}
          <div className="ai-usage-summary-grid">
            <div className="ai-usage-summary-card">
              <span className="ai-usage-summary-label">调用次数</span>
              <span className="ai-usage-summary-num">{formatInt(summary.totals.calls)}</span>
            </div>
            <div className="ai-usage-summary-card">
              <span className="ai-usage-summary-label">输入 Token</span>
              <span className="ai-usage-summary-num">{formatInt(summary.totals.inputTokens)}</span>
            </div>
            <div className="ai-usage-summary-card">
              <span className="ai-usage-summary-label">输出 Token</span>
              <span className="ai-usage-summary-num">{formatInt(summary.totals.outputTokens)}</span>
            </div>
            <div className="ai-usage-summary-card">
              <span className="ai-usage-summary-label">输入字数</span>
              <span className="ai-usage-summary-num">{formatInt(summary.totals.inputChars)}</span>
            </div>
            <div className="ai-usage-summary-card">
              <span className="ai-usage-summary-label">输出字数</span>
              <span className="ai-usage-summary-num">{formatInt(summary.totals.outputChars)}</span>
            </div>
          </div>

          {/* 子维度导航 */}
          <div className="ai-usage-subnav">
            {views.map((v) => (
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
              {byDay.length > 0 && (
                <>
                  <div className="ai-usage-sub-title">每日趋势（Token）</div>
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
                          <span className="ai-usage-day-num" title={formatInt(total)}>{formatCompact(total)}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {byProject.length > 0 && (
                <>
                  <div className="ai-usage-sub-title">项目消耗排行（Top 10）</div>
                  <div className="ai-usage-table-wrap">
                    <table className="ai-usage-table">
                      <thead>
                        <tr>
                          <th>项目编号</th><th>项目名称</th>{isAdminView && <th>所属用户</th>}
                          <th className="ai-usage-num">调用</th><th className="ai-usage-num">输入 Token</th>
                          <th className="ai-usage-num">输出 Token</th><th className="ai-usage-num">合计 Token</th>
                          <th className="ai-usage-num">生图</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byProject.slice(0, 10).map((proj) => (
                          <ProjectRow key={proj.projectId} proj={proj} showOwner={isAdminView} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ===== 按项目 ===== */}
          {view === 'projects' && (
            <div className="ai-usage-view">
              <div className="ai-usage-filters">
                {isAdminView && (
                  <label className="ai-usage-filter">
                    <span>用户</span>
                    <select
                      value={filterUserId}
                      onChange={(event) => {
                        const value = event.target.value;
                        setFilterUserId(value ? Number(value) : '');
                        setPage(1);
                      }}
                    >
                      <option value="">全部用户</option>
                      {(summary.filterOptions?.users ?? []).map((item) => (
                        <option key={item.userId} value={item.userId}>{item.username}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="ai-usage-filter ai-usage-filter-grow">
                  <span>项目</span>
                  <input
                    type="text"
                    value={keywordDraft}
                    placeholder="项目名称 / 编号 / ID"
                    onChange={(event) => setKeywordDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { setKeyword(keywordDraft); setPage(1); }
                    }}
                  />
                </label>
                <button type="button" className="inline-action" onClick={() => { setKeyword(keywordDraft); setPage(1); }}>查询</button>
                {(keyword || filterUserId !== '') && (
                  <button
                    type="button"
                    className="inline-action"
                    onClick={() => { setKeyword(''); setKeywordDraft(''); setFilterUserId(''); setPage(1); }}
                  >
                    清除筛选
                  </button>
                )}
                <span className="ai-usage-filter-hint">{loading ? '加载中…' : `共 ${byProject.length} 个项目`}</span>
              </div>

              {(summary.filters?.keyword || filterUserId !== '') && (
                <p className="ai-usage-filter-note">
                  已筛选：
                  {filterUserId !== ''
                    ? `用户 ${summary.filterOptions?.users.find((u) => u.userId === filterUserId)?.username || filterUserId}；`
                    : ''}
                  {summary.filters?.keyword ? `项目关键字「${summary.filters.keyword}」` : ''}
                  合计 {formatInt(summary.totals.calls)} 次调用
                </p>
              )}

              {byProject.length === 0 ? (
                <p className="ai-usage-empty">暂无项目数据。</p>
              ) : (
                <div className="ai-usage-table-wrap">
                  <table className="ai-usage-table">
                    <thead>
                      <tr>
                        <th>项目编号</th><th>项目名称</th>{isAdminView && <th>所属用户</th>}
                        <th className="ai-usage-num">调用</th><th className="ai-usage-num">输入 Token</th>
                        <th className="ai-usage-num">输出 Token</th><th className="ai-usage-num">合计 Token</th>
                        <th className="ai-usage-num">生图</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProject.map((proj) => (
                        <ProjectRow key={proj.projectId} proj={proj} showOwner={isAdminView} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ===== 按用户（仅管理员） ===== */}
          {view === 'users' && isAdminView && (
            <div className="ai-usage-view">
              {byUser.length === 0 ? (
                <p className="ai-usage-empty">暂无用户数据。</p>
              ) : (
                <div className="ai-usage-table-wrap">
                  <table className="ai-usage-table">
                    <thead>
                      <tr>
                        <th>用户</th><th className="ai-usage-num">调用</th><th className="ai-usage-num">输入 Token</th>
                        <th className="ai-usage-num">输出 Token</th><th className="ai-usage-num">合计 Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byUser.map((item) => (
                        <tr key={item.userId}>
                          <td>{item.username}</td>
                          <td className="ai-usage-num">{formatInt(item.calls)}</td>
                          <td className="ai-usage-num">{formatInt(item.inputTokens)}</td>
                          <td className="ai-usage-num">{formatInt(item.outputTokens)}</td>
                          <td className="ai-usage-num ai-usage-num-strong">{formatInt(item.inputTokens + item.outputTokens)}</td>
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
                      <tr>
                        <th>模型</th><th className="ai-usage-num">调用</th><th className="ai-usage-num">输入 Token</th>
                        <th className="ai-usage-num">输出 Token</th><th className="ai-usage-num">合计 Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byModel.map((m) => (
                        <tr key={m.key}>
                          <td>{m.label}</td>
                          <td className="ai-usage-num">{formatInt(m.calls)}</td>
                          <td className="ai-usage-num">{formatInt(m.inputTokens)}</td>
                          <td className="ai-usage-num">{formatInt(m.outputTokens)}</td>
                          <td className="ai-usage-num ai-usage-num-strong">{formatInt(m.inputTokens + m.outputTokens)}</td>
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
                      <tr>
                        <th>服务商</th><th className="ai-usage-num">调用</th><th className="ai-usage-num">输入 Token</th>
                        <th className="ai-usage-num">输出 Token</th><th className="ai-usage-num">合计 Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProvider.map((p) => (
                        <tr key={p.key}>
                          <td>{p.label}</td>
                          <td className="ai-usage-num">{formatInt(p.calls)}</td>
                          <td className="ai-usage-num">{formatInt(p.inputTokens)}</td>
                          <td className="ai-usage-num">{formatInt(p.outputTokens)}</td>
                          <td className="ai-usage-num ai-usage-num-strong">{formatInt(p.inputTokens + p.outputTokens)}</td>
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
                    <tr>
                      <th>类型</th><th>时间</th>{isAdminView && <th>用户</th>}<th>模型</th>
                      <th className="ai-usage-num">输入 Token</th><th className="ai-usage-num">输出 Token</th>
                      <th>项目</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.items.map((item) => (
                      <tr key={item.id}>
                        <td>{bizLabel(item.bizType)}</td>
                        <td>{formatDate(item.createdAt)}</td>
                        {isAdminView && <td>{item.username || '-'}</td>}
                        <td>{item.model || item.provider || '-'}</td>
                        <td className="ai-usage-num">{formatInt(item.inputTokens)}<span className="ai-usage-sub"> / {formatInt(item.inputChars)} 字</span></td>
                        <td className="ai-usage-num">{formatInt(item.outputTokens)}<span className="ai-usage-sub"> / {formatInt(item.outputChars)} 字</span></td>
                        <td>{item.projectId != null ? `#${item.projectId}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="ai-usage-pager">
                  <button type="button" className="inline-action" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                  <span>{page} / {totalPages} 页（共 {formatInt(summary.totalRows)} 条）</span>
                  <button type="button" className="inline-action" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
                </div>
              </div>
            </div>
          )}

          <div className="settings-pricing-actions ai-usage-footnote">
            <span className="settings-pricing-hint">
              Token 来自模型返回的 usage；生图服务商通常不返回 token，只统计调用次数。统计仅展示，不扣费不限流。
            </span>
          </div>
        </>
      )}
    </section>
  );
}
