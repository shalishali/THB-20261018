// 额度管理弹窗（管理员）：查看余额/已用/累计充值，手动调整额度（增减/设为，单位万字），查看操作记录。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  adjustUserQuota,
  fetchAdjustLogs,
  formatQuotaChars,
  type AdminAuditLogInfo,
} from '../../../shared/api/quota';

const ACTION_LABEL: Record<string, string> = {
  'quota.adjust': '额度调整',
  'user.update': '账号编辑',
  'user.delete': '账号删除',
};

interface QuotaAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: number;
    username: string;
    displayName: string | null;
    quotaChars?: number;
    quotaUsedChars?: number;
    totalRechargeCents?: number;
    totalRechargeChars?: number;
  } | null;
  onAdjusted: () => void;
}

function QuotaAdjustDialog({ open, onOpenChange, user, onAdjusted }: QuotaAdjustDialogProps) {
  const [mode, setMode] = useState<'delta' | 'set'>('delta');
  const [wanInput, setWanInput] = useState('');
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<AdminAuditLogInfo[]>([]);

  useEffect(() => {
    if (!open || !user) return;
    setMode('delta');
    setWanInput('');
    setRemark('');
    setError('');
    fetchAdjustLogs(user.id)
      .then((data) => setLogs(data.logs || []))
      .catch(() => setLogs([]));
  }, [open, user]);

  if (!user) return null;

  const submit = async () => {
    if (submitting) return;
    const parsed = Number(wanInput);
    setError('');
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('请输入大于 0 的字数（单位：万字）');
      return;
    }
    const chars = Math.round(parsed * 10000);
    const payload = mode === 'delta'
      ? { deltaChars: chars, remark: remark.trim() }
      : { setChars: chars, remark: remark.trim() };
    setSubmitting(true);
    try {
      await adjustUserQuota(user.id, payload);
      onAdjusted();
      const data = await fetchAdjustLogs(user.id);
      setLogs(data.logs || []);
      setWanInput('');
      setRemark('');
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      setError(anyErr.response?.data?.error || (err instanceof Error ? err.message : '调整失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="quota-dialog-overlay" />
        <Dialog.Content className="quota-dialog" aria-describedby={undefined}>
          <div className="quota-dialog-head">
            <Dialog.Title>额度管理 — {user.displayName || user.username}</Dialog.Title>
            <Dialog.Close className="quota-dialog-close" aria-label="关闭">×</Dialog.Close>
          </div>

          <div className="quota-summary-grid">
            <div><small>当前余额</small><strong>{formatQuotaChars(user.quotaChars)}</strong></div>
            <div><small>已用额度</small><strong>{formatQuotaChars(user.quotaUsedChars)}</strong></div>
            <div><small>累计充值</small><strong>{(user.totalRechargeCents ?? 0) > 0 ? `¥${((user.totalRechargeCents ?? 0) / 100).toFixed(2)}` : '—'}</strong></div>
            <div><small>充值字数</small><strong>{formatQuotaChars(user.totalRechargeChars)}</strong></div>
          </div>

          <div className="quota-adjust-form">
            <div className="quota-adjust-row">
              <select value={mode} onChange={(event) => setMode(event.target.value as 'delta' | 'set')} aria-label="调整方式">
                <option value="delta">增加额度</option>
                <option value="set">设为指定余额</option>
              </select>
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="字数（万字）"
                value={wanInput}
                onChange={(event) => setWanInput(event.target.value)}
                aria-label="字数（万字）"
              />
              <span>万字</span>
            </div>
            <input
              type="text"
              placeholder="备注（可选，如：线下收款凭证号）"
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              aria-label="调整备注"
            />
            <button type="button" className="primary-action" onClick={() => { void submit(); }} disabled={submitting}>
              {submitting ? '提交中…' : mode === 'delta' ? '确认增加' : '确认设置'}
            </button>
            {error && <p className="quota-error">{error}</p>}
          </div>

          <div className="quota-orders">
            <strong>操作记录</strong>
            {logs.length ? (
              <ul>
                {logs.map((log) => {
                  const detail = (log.detail || {}) as { before?: number; after?: number; delta?: number; remark?: string; targetUsername?: string; fields?: string[]; passwordReset?: boolean };
                  const desc = log.action === 'quota.adjust'
                    ? `余额 ${formatQuotaChars(detail.before)} → ${formatQuotaChars(detail.after)}${detail.remark ? `（${detail.remark}）` : ''}`
                    : log.action === 'user.delete'
                      ? `删除账号${detail.targetUsername ? `「${detail.targetUsername}」` : ''}`
                      : `编辑账号${detail.fields?.length ? `：${detail.fields.join('、')}` : ''}`;
                  return (
                    <li key={log.id}>
                      <span>{new Date(log.createdAt).toLocaleString()}</span>
                      <span>{ACTION_LABEL[log.action] || log.action}</span>
                      <span className="quota-log-desc">{desc}</span>
                      <em>{log.adminUsername}</em>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="quota-orders-empty">暂无操作记录</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default QuotaAdjustDialog;
