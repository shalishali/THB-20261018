import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

export interface OutlineRootPreviewGroup {
  requirement_id?: string;
  title: string;
  description?: string;
  detail_points?: string[];
}

interface OutlineRootConfirmDialogProps {
  open: boolean;
  groups: OutlineRootPreviewGroup[];
  loading?: boolean;
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReextract: (suggestions: string) => void;
}

const AUTO_CONFIRM_SECONDS = 10;

// STEP03 先生成前确认：从招标解析结果中提取的技术评分大项 = 技术方案一级目录。
// 不回点则 10 秒后自动按当前目录继续；输入调整要求时暂停倒计时，避免用户还在输入就被确认。
function OutlineRootConfirmDialog({ open, groups, loading = false, submitting = false, onConfirm, onCancel, onReextract }: OutlineRootConfirmDialogProps) {
  const [countdown, setCountdown] = useState(AUTO_CONFIRM_SECONDS);
  const [suggestions, setSuggestions] = useState('');

  useEffect(() => {
    if (!open) return;
    setCountdown(AUTO_CONFIRM_SECONDS);
    setSuggestions('');
  }, [open, groups]);

  useEffect(() => {
    if (!open || loading || submitting || suggestions.trim()) return;
    const timer = setInterval(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [open, loading, submitting, suggestions]);

  useEffect(() => {
    if (!open || loading || submitting || suggestions.trim()) return;
    if (countdown <= 0) onConfirm();
  }, [countdown, open, loading, submitting, suggestions, onConfirm]);

  if (!open) return null;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="agent-question-card outline-root-confirm-card">
          <div className="agent-question-head">
            <Dialog.Title>确认技术方案一级目录</Dialog.Title>
            <Dialog.Description>
              以下是从招标文件技术评分项提取的一级目录，确认后将进入字数设置并开始生成。
              {!loading && !submitting && !suggestions.trim() && (
                <span className="outline-root-confirm-countdown">（{countdown} 秒后自动确认）</span>
              )}
            </Dialog.Description>
          </div>

          <section className="agent-question-summary">
            <div className="agent-question-detected-items">
              <strong>技术评分大项 · {groups.length} 项</strong>
              <ol className="outline-root-confirm-list">
                {groups.map((group, index) => (
                  <li key={`${group.requirement_id || index}-${group.title}`}>
                    <strong>{group.title}</strong>
                    {group.description && <small>{group.description}</small>}
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <label className="outline-root-confirm-adjust">
            <span>需要调整？填写要求后点「重新提取」（例如：合并“服务方案”与“质量保障措施”、去掉“培训方案”）</span>
            <textarea
              value={suggestions}
              onChange={(event) => setSuggestions(event.target.value)}
              placeholder="输入希望增加、删除、合并或改名的一级目录要求"
              rows={3}
              disabled={loading || submitting}
            />
          </label>

          <div className="agent-question-actions">
            <span className="agent-question-manual-note">不操作将在 10 秒后按当前目录自动确认。</span>
            <div className="agent-question-action-buttons">
              <button type="button" className="secondary-action" onClick={onCancel} disabled={loading || submitting}>
                取消
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => onReextract(suggestions.trim())}
                disabled={loading || submitting || !suggestions.trim()}
              >
                {loading ? '正在重新提取...' : '重新提取'}
              </button>
              <button type="button" className="primary-action" onClick={onConfirm} disabled={loading || submitting}>
                {submitting ? '正在启动...' : '确认并继续'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default OutlineRootConfirmDialog;
