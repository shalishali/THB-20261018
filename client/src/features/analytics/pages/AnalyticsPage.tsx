// 数据看板（仅管理员）：站点访问/登录/注册概览 + 日趋势 + 未活跃用户 + 操作记录
import { useEffect, useState } from 'react';
import {
  fetchActivityLogs,
  fetchAnalyticsOverview,
  fetchInactiveUsers,
  fetchErrorLogs,
  resolveErrorLog,
  type AnalyticsActivityItem,
  type AnalyticsOverview,
  type ErrorLogInfo,
  type InactiveUserInfo,
} from '../../../shared/api/analytics';

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  register: '注册',
  'project.create': '新建项目',
  'import.tender': '导入招标文件',
  'task.content-generation': '生成正文',
  'task.bid-analysis': '招标解析',
  'task.outline-generation': '生成目录',
  'task.global-facts-generation': '生成全局事实',
  'task.rejection-items-extraction': '废标项提取',
  'task.rejection-check': '废标检查',
  'task.duplicate-analysis': '标书查重',
  'task.bid-section-extraction': '多标段识别',
  export: '导出标书',
  'quota.adjust': '额度调整',
  'user.update': '账号编辑',
  'user.delete': '账号删除',
};

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [inactive, setInactive] = useState<InactiveUserInfo[]>([]);
  const [activity, setActivity] = useState<AnalyticsActivityItem[]>([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityPage, setActivityPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      fetchAnalyticsOverview(days),
      fetchInactiveUsers(days),
      fetchActivityLogs({ page: activityPage, pageSize: 20 }),
    ])
      .then(([ov, inact, act]) => {
        if (cancelled) return;
        setOverview(ov);
        setInactive(inact.users || []);
        setActivity(act.items || []);
        setActivityTotal(act.total || 0);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, activityPage]);

  const maxSeries = Math.max(1, ...(overview?.series || []).map((row) => Math.max(row.visits, row.logins, row.registrations)));

  const statCards = overview ? [
    { label: `近 ${days} 天访问`, value: fmt(overview.visits), hint: `独立登录用户 ${fmt(overview.uniqueVisitors)}` },
    { label: `近 ${days} 天登录`, value: fmt(overview.logins), hint: `新增注册 ${fmt(overview.registrations)}` },
    { label: '注册用户', value: fmt(overview.totalUsers), hint: `7 天以上未活跃 ${fmt(overview.inactiveUsers)}` },
    { label: '近 7 天活跃用户', value: fmt(overview.activeUsers), hint: `近 ${days} 天导出 ${fmt(overview.exports)} 次 · AI 调用 ${fmt(overview.aiCalls)}` },
  ] : [];

  return (
    <div className="analytics-page">
      <div className="analytics-shell">
        <header className="analytics-head">
          <div className="analytics-head-text">
            <span className="section-kicker">数据看板</span>
            <h2>站点访问与用户分析</h2>
            <p>访问量、注册转化、用户活跃与操作记录（仅管理员可见）。</p>
          </div>
          <select
            className="analytics-days-select"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            aria-label="统计范围"
          >
            <option value={1}>近 24 小时</option>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
        </header>

        {/* 概览卡 */}
        <div className="analytics-statbar">
          {loading && !overview
            ? <div className="analytics-stat"><small>加载中…</small></div>
            : statCards.map((card) => (
              <div className="analytics-stat" key={card.label}>
                <small>{card.label}</small>
                <strong>{card.value}</strong>
                <span>{card.hint}</span>
              </div>
            ))}
        </div>

        {/* 日趋势（纯 CSS 柱状） */}
        <div className="analytics-trend">
          <strong>访问 / 登录 / 注册 · 日趋势</strong>
          <div className="analytics-trend-chart" role="img" aria-label="访问登录注册日趋势柱状图">
            {(overview?.series || []).map((row) => {
              const h1 = Math.round((row.visits / maxSeries) * 100);
              const h2 = Math.round((row.logins / maxSeries) * 100);
              const h3 = Math.round((row.registrations / maxSeries) * 100);
              return (
                <div className="analytics-trend-col" key={row.date} title={`${row.date}：访问 ${row.visits} · 登录 ${row.logins} · 注册 ${row.registrations}`}>
                  <div className="analytics-trend-bars">
                    <i style={{ height: `${Math.max(h1, 2)}%` }} className="is-visits" />
                    <i style={{ height: `${Math.max(h2, 2)}%` }} className="is-logins" />
                    <i style={{ height: `${Math.max(h3, 2)}%` }} className="is-registrations" />
                  </div>
                  <small>{row.date.slice(5)}</small>
                </div>
              );
            })}
            {!overview?.series?.length && <p className="analytics-trend-empty">暂无数据</p>}
          </div>
          <div className="analytics-trend-legend">
            <span><i className="is-visits" />访问（页面打点）</span>
            <span><i className="is-logins" />登录</span>
            <span><i className="is-registrations" />注册</span>
          </div>
        </div>

        {/* 未活跃用户 */}
        <div className="analytics-card">
          <strong>未活跃用户（{days} 天以上无操作，共 {inactive.length} 人）</strong>
          {inactive.length ? (
            <table className="analytics-table">
              <thead>
                <tr><th>手机号</th><th>昵称</th><th>注册时间</th><th>最近活跃</th><th>剩余额度</th><th>已用字数</th></tr>
              </thead>
              <tbody>
                {inactive.map((u) => (
                  <tr key={u.id}>
                    <td>{u.phone || u.username}</td>
                    <td>{u.displayName || '—'}</td>
                    <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>{u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : '从未活跃'}</td>
                    <td>{fmt(u.quotaChars)}</td>
                    <td>{fmt(u.quotaUsedChars)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="analytics-empty">暂无未活跃用户</p>
          )}
        </div>

        {/* 操作记录 */}
        <div className="analytics-card">
          <div className="analytics-card-head">
            <strong>用户操作记录（共 {fmt(activityTotal)} 条）</strong>
            <span>
              <button type="button" className="inline-action" disabled={activityPage <= 1} onClick={() => setActivityPage((p) => Math.max(1, p - 1))}>上一页</button>
              {' '}{activityPage} · 共 {Math.max(1, Math.ceil(activityTotal / 20))} 页{' '}
              <button type="button" className="inline-action" disabled={activityPage * 20 >= activityTotal} onClick={() => setActivityPage((p) => p + 1)}>下一页</button>
            </span>
          </div>
          {activity.length ? (
            <ul className="analytics-activity">
              {activity.map((item) => (
                <li key={item.id}>
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <strong>{item.username}</strong>
                  <em>{ACTION_LABEL[item.action] || item.action}</em>
                  {item.detail ? <code>{JSON.stringify(item.detail).slice(0, 120)}</code> : null}
                  {item.ip ? <small>{item.ip}</small> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="analytics-empty">暂无记录</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AnalyticsPage;
