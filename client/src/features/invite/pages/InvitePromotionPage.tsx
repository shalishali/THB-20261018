import { useCallback, useEffect, useState } from 'react';
import { inviteApi, type InvitePromotionSummary } from '../../../shared/api/invite';
import { useSystemSettings } from '../../../shared/api/system-settings';
import { formatQuotaChars } from '../../../shared/api/quota';
import { useToast } from '../../../shared/ui';

// FE-16：邀请推广页面（个人端，一期仅展示）。
// 数据源 GET /api/invite/promotion（API-15，只含本人作为邀请人的数据，下线姓名/手机号后端已脱敏）；
// 邀请归因：同行经邀请链接（登录页根路径 ?invite=码）登录后自动绑定邀请关系，首绑唯一；
// 登录页已去掉手填邀请码，用户无需输入任何码。

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function formatAmount(value: string | undefined): string {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

export default function InvitePromotionPage() {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<InvitePromotionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextPage: number) => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await inviteApi.promotion({ page: nextPage, pageSize: 20 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取推广数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(page); }, [load, page]);

  const copy = useCallback((label: string, text: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => showToast(`${label}已复制`, 'success'))
      .catch(() => showToast('复制失败，请手动选择内容复制', 'error'));
  }, [showToast]);

  const inviteCode = summary?.inviteCode || '';
  const inviteUrl = summary?.inviteUrl || '';
  const { data: systemSettings } = useSystemSettings();
  // 推广文案：管理员可在基本设置自定义（支持 {inviteCode}/{inviteUrl} 占位符）；未自定义用内置默认。
  const promoText = (() => {
    if (!inviteUrl) return '';
    const custom = (systemSettings?.invitePromoCopy || '').trim();
    if (custom) {
      return custom
        .replace(/\{inviteCode\}/g, inviteCode)
        .replace(/\{inviteUrl\}/g, inviteUrl)
        .replace(/\{邀请码\}/g, inviteCode)
        .replace(/\{链接\}/g, inviteUrl);
    }
    return `想要投好标，就交给「投好标」！上传文件一键生成技术方案，点链接登录直接送 10 万字额度👉${inviteUrl}`;
  })();
  const totalPages = summary ? Math.max(1, Math.ceil(summary.total / summary.pageSize)) : 1;

  return (
    <div className="invite-promo-page">
      {/* 邀请 Hero：渐变主卡；链接是分享入口，邀请码仅作后台识别 */}
      <section className="invite-hero">
        <div className="invite-hero-main">
          <span className="invite-hero-kicker">邀请推广</span>
          <h2>邀请好友，<em>返利 {summary?.rebatePercent ?? 30}%</em></h2>
          <p>把专属邀请链接分享给写标同行：对方打开链接登录即自动绑定邀请关系，无需填写邀请码（仅首个邀请人有效、不可变更）。好友充值到账后你可获得其充值金额 {summary?.rebatePercent ?? 30}% 的返利，冻结 {summary?.freezeDays ?? 30} 天后即可结算提现。</p>
          <div className="invite-hero-actions">
            <button type="button" className="btn-hero" onClick={() => copy('邀请链接', inviteUrl)} disabled={!inviteUrl}>复制邀请链接</button>
            <button type="button" className="btn-hero-ghost" onClick={() => copy('推广文案', promoText)} disabled={!promoText}>复制推广文案</button>
            <button type="button" className="invite-hero-refresh" onClick={() => void load(page)} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
          </div>
        </div>
        <div className="invite-hero-code">
          <small>我的邀请码（好友无需填写）</small>
          <strong>{inviteCode || '———'}</strong>
          <button type="button" className="inline-action" onClick={() => copy('邀请码', inviteCode)} disabled={!inviteCode}>复制邀请码</button>
        </div>
      </section>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      {summary && (
        <>
          {/* 数据总览 */}
          <div className="invite-statbar">
            <div className="invite-stat"><small>邀请注册</small><strong>{summary.inviteeCount}<em>人</em></strong></div>
            <div className="invite-stat"><small>待结算返利</small><strong>¥{formatAmount(summary.pendingRebateAmount)}</strong></div>
            <div className="invite-stat"><small>返利比例</small><strong>{summary.rebatePercent ?? 30}<em>%</em></strong></div>
            <div className="invite-stat"><small>冻结周期</small><strong>{summary.freezeDays ?? 30}<em>天</em></strong></div>
          </div>

          {/* 推广文案 */}
          <div className="invite-promo-copy-block">
            <div className="invite-promo-copy-head">
              <span>推广文案（一键复制发同行）</span>
              <button type="button" className="inline-action" onClick={() => copy('推广文案', promoText)} disabled={!promoText}>复制</button>
            </div>
            <p className="invite-promo-copy-text">{promoText || '加载中…'}</p>
          </div>

          {/* 邀请海报（管理员可在后台配置；未配置则不展示） */}
          {summary.invitePosterDataUrl && (
            <div className="invite-poster-block">
              <div className="invite-promo-copy-head">
                <span>邀请海报</span>
                <a className="inline-action" href={summary.invitePosterDataUrl} download={`invite-poster-${inviteCode || 'share'}.png`}>
                  下载海报
                </a>
              </div>
              <img className="invite-poster-image" src={summary.invitePosterDataUrl} alt="邀请推广海报" />
            </div>
          )}

          {/* 我的下线 */}
          <div className="invite-downline-card">
            <div className="invite-downline-head">
              <strong>我的下线（共 {summary.total} 人）</strong>
              <span>
                <button type="button" className="inline-action" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                {' '}
                <button type="button" className="inline-action" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
                {' '}{page} / {totalPages}
              </span>
            </div>

            {summary.items.length === 0 && !loading && (
              <p className="invite-promo-empty">还没有下线。把邀请链接发给写标同行，对方登录成功后会自动出现在这里。</p>
            )}

            {summary.items.length > 0 && (
              <table className="invite-downline-table">
                <thead>
                  <tr>
                    <th>下线</th>
                    <th>注册时间</th>
                    <th>剩余额度</th>
                    <th>已用字数</th>
                    <th>累计充值</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <small>{item.phone}</small>
                      </td>
                      <td>{formatDate(item.registeredAt)}</td>
                      <td>{formatQuotaChars(item.quotaChars)}</td>
                      <td>{formatQuotaChars(item.quotaUsedChars)}</td>
                      <td>{(item.totalRechargeCents ?? 0) > 0 ? `¥${((item.totalRechargeCents ?? 0) / 100).toFixed(2)}` : '—'}</td>
                      <td><em className={`invite-status is-${item.status}`}>{item.status === 'bound' ? '绑定有效' : item.status}</em></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
