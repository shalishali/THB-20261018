import { useCallback, useEffect, useState } from 'react';
import { inviteApi, type InvitePromotionSummary } from '../../../shared/api/invite';
import { useToast } from '../../../shared/ui';

// FE-16：邀请推广页面（个人端，一期仅展示）。
// 数据源 GET /api/invite/promotion（API-15，只含本人作为邀请人的数据，下线姓名/手机号后端已脱敏）；
// 邀请归因：同行经邀请链接（登录页根路径 ?invite=码，FE-14 已支持自动填入注册表单）注册后首绑唯一。

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
  const promoText = inviteUrl
    ? `我在用「投好标」写投标文件：上传招标文件，AI 生成技术方案，又快又稳。用我的邀请码 ${inviteCode} 注册：${inviteUrl}`
    : '';
  const totalPages = summary ? Math.max(1, Math.ceil(summary.total / summary.pageSize)) : 1;

  return (
    <div className="invite-promo-page">
      <div className="invite-promo-head">
        <div>
          <h2>邀请推广</h2>
          <p>把专属邀请码分享给写标同行；对方注册后即建立邀请关系（仅首个邀请人有效、不可变更）。一期仅记录返利流水与展示，结算提现将在二期上线。</p>
        </div>
        <button type="button" className="primary-action" onClick={() => void load(page)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      {summary && (
        <>
          <section className="settings-page-section invite-promo-hero">
            <div className="settings-section-title"><span /><strong>推广数据</strong></div>
            <div className="ai-diagnostics-statbar">
              <span><strong>{summary.inviteeCount}</strong> 邀请注册（人）</span>
              <span><strong>{formatAmount(summary.pendingRebateAmount)}</strong> 累计待结算返利（元）</span>
            </div>
            <div className="invite-promo-share">
              <div className="invite-promo-share-row">
                <span className="invite-promo-share-label">我的邀请码</span>
                <strong className="invite-promo-code">{inviteCode || '—'}</strong>
                <button type="button" className="inline-action" onClick={() => copy('邀请码', inviteCode)} disabled={!inviteCode}>
                  复制邀请码
                </button>
              </div>
              <div className="invite-promo-share-row">
                <span className="invite-promo-share-label">邀请链接</span>
                <code className="invite-promo-url">{inviteUrl || '—'}</code>
                <button type="button" className="inline-action" onClick={() => copy('邀请链接', inviteUrl)} disabled={!inviteUrl}>
                  复制链接
                </button>
              </div>
              <div className="invite-promo-copy-block">
                <div className="invite-promo-copy-head">
                  <span>推广文案</span>
                  <button type="button" className="inline-action" onClick={() => copy('推广文案', promoText)} disabled={!promoText}>
                    一键复制
                  </button>
                </div>
                <p className="invite-promo-copy-text">{promoText || '加载中…'}</p>
              </div>
              <p className="invite-promo-tip">说明：返利金额以系统流水记录为准；退款、冻结与结算规则将在二期上线后生效。</p>
            </div>
          </section>

          <section className="settings-page-section invite-promo-list">
            <div className="settings-section-title"><span /><strong>我的下线（共 {summary.total} 人）</strong></div>
            <div className="ai-diagnostics-list invite-promo-downlines">
              <div className="ai-diagnostics-list-head">
                <strong>下线列表</strong>
                <span>
                  <button type="button" className="inline-action" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                  {' '}
                  <button type="button" className="inline-action" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
                  {' '}{page} / {totalPages}
                </span>
              </div>

              {summary.items.length === 0 && !loading && (
                <p className="invite-promo-empty">还没有下线。把邀请链接发给写标同行，对方注册成功后会出现在这里。</p>
              )}

              {summary.items.map((item) => (
                <article key={item.id} className="ai-diagnostic-attempt is-neutral">
                  <div className="ai-diagnostic-attempt-head">
                    <strong>{item.name}</strong>
                    <span>{formatDate(item.registeredAt)}</span>
                  </div>
                  <div className="ai-diagnostic-attempt-metrics">
                    <span>{item.phone}</span>
                    <span>{item.status === 'bound' ? '绑定有效' : item.status}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
