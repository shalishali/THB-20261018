import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPendingQuestion } from '../../../shared/api/agent';

const AUTO_CONTINUE_SECONDS = 20;

interface AgentQuestionDialogProps {
  question: AgentPendingQuestion | null;
  submitting?: boolean;
  onSubmit: (optionId: string, customAnswer?: string) => void;
  onDefer: () => void;
}

function getMetadataRecord(question: AgentPendingQuestion | null): Record<string, unknown> {
  return question?.metadata && typeof question.metadata === 'object' && !Array.isArray(question.metadata)
    ? question.metadata as Record<string, unknown>
    : {};
}

function getRecommendedOptionId(question: AgentPendingQuestion | null): string {
  const recommended = question?.options.find((option) => option.recommended);
  return recommended?.id || recommended?.label || question?.options[0]?.id || question?.options[0]?.label || '';
}

function formatQuestionItems(question: AgentPendingQuestion | null): string[] {
  const metadata = getMetadataRecord(question);
  const items = Array.isArray(metadata.items) ? metadata.items : [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const title = (item as Record<string, unknown>).title;
        return typeof title === 'string' ? title.trim() : '';
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 9);
}

function isLeafCountQuestion(question: AgentPendingQuestion | null): boolean {
  if (!question) return false;
  const metadata = getMetadataRecord(question);
  return metadata.title === '目录叶子数量' || /叶子小节数量/.test(question.question);
}

function AgentQuestionDialog({ question, submitting = false, onSubmit, onDefer }: AgentQuestionDialogProps) {
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const [autoContinue, setAutoContinue] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(AUTO_CONTINUE_SECONDS);
  const metadata = useMemo(() => getMetadataRecord(question), [question]);
  const itemTitles = useMemo(() => formatQuestionItems(question), [question]);
  const recommendedOptionId = useMemo(() => getRecommendedOptionId(question), [question]);

  // 定时器回调里读取最新选择/提交状态，避免闭包拿到打开弹窗那一帧的旧值。
  const selectedOptionIdRef = useRef('');
  const selectedNeedsCustomAnswerRef = useRef(false);
  const submittingRef = useRef(submitting);
  const onSubmitRef = useRef(onSubmit);
  selectedOptionIdRef.current = selectedOptionId;
  submittingRef.current = submitting;
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    setSelectedOptionId(getRecommendedOptionId(question));
    setCustomAnswer('');
    setAutoContinue(isLeafCountQuestion(question));
    setRemainingSeconds(AUTO_CONTINUE_SECONDS);
  }, [question?.question_id]);

  // 目录叶子数量超预算时，用户 20 秒不操作则按推荐选项自动继续，避免目录生成长期卡在人工确认。
  // 只对这一个问题生效；其他 Agent 问题仍必须人工确认。用户点击任一选项后立即取消自动继续。
  useEffect(() => {
    if (!question || !autoContinue || submitting) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, AUTO_CONTINUE_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
      setRemainingSeconds(left);
      if (left > 0) return;
      window.clearInterval(timer);
      const optionId = selectedOptionIdRef.current;
      if (!optionId || selectedNeedsCustomAnswerRef.current || submittingRef.current) return;
      setAutoContinue(false);
      onSubmitRef.current(optionId);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [question?.question_id, autoContinue, submitting]);

  if (!question) return null;

  const title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : '需要确认的内容';
  const itemCount = typeof metadata.item_count === 'number' ? metadata.item_count : itemTitles.length;
  const selectedOption = question.options.find((option) => (option.id || option.label) === selectedOptionId);
  const selectedIsDefer = selectedOption?.id === 'defer' || /稍后|暂停|处理/.test(selectedOption?.label || '');
  const selectedNeedsCustomAnswer = selectedOption?.custom === true;
  selectedNeedsCustomAnswerRef.current = selectedNeedsCustomAnswer;
  const confirmDisabled = submitting || !selectedOptionId || (selectedNeedsCustomAnswer && !customAnswer.trim());
  const autoContinueOptionLabel = selectedOption?.label || question.options.find((option) => (option.id || option.label) === recommendedOptionId)?.label || '推荐选项';

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="agent-question-card">
          <div className="agent-question-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description>
              {question.task_title || '提交后，后台 Agent 会继续执行当前任务。'}
            </Dialog.Description>
          </div>

          <section className="agent-question-summary">
            <p>{question.question}</p>
            {itemTitles.length > 0 && (
              <div className="agent-question-detected-items">
                <strong>相关内容 · {itemCount} 项</strong>
                <span>{itemTitles.join('、')}</span>
              </div>
            )}
          </section>

          <div className="agent-question-options" role="radiogroup" aria-label="确认选项">
            {question.options.map((option) => {
              const optionId = option.id || option.label;
              const active = selectedOptionId === optionId;
              return (
                <button
                  type="button"
                  key={optionId}
                  className={`agent-question-option${active ? ' is-active' : ''}`}
                  onClick={() => {
                    setAutoContinue(false);
                    setSelectedOptionId(optionId);
                  }}
                  role="radio"
                  aria-checked={active}
                  disabled={submitting}
                >
                  <span className="agent-question-radio" aria-hidden="true" />
                  <span className="agent-question-option-copy">
                    <strong>
                      {option.label}
                      {(option.recommended || optionId === recommendedOptionId) && <em>推荐</em>}
                    </strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedNeedsCustomAnswer && (
            <label className="agent-question-custom-answer">
              <span>请补充你的具体要求（必填）</span>
              <textarea
                value={customAnswer}
                onFocus={() => setAutoContinue(false)}
                onChange={(event) => {
                  setAutoContinue(false);
                  setCustomAnswer(event.target.value);
                }}
                placeholder="请输入你的具体要求"
                rows={4}
                disabled={submitting}
              />
            </label>
          )}

          <div className="agent-question-actions">
            <span className="agent-question-manual-note" aria-live="polite">
              {autoContinue && !submitting
                ? `若不操作，${remainingSeconds} 秒后将按「${autoContinueOptionLabel}」自动继续。`
                : '请人工确认后继续，确认后将按你的选择继续执行。'}
            </span>
            <div className="agent-question-action-buttons">
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  setAutoContinue(false);
                  onDefer();
                }}
                disabled={submitting}
              >
                稍后处理
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  setAutoContinue(false);
                  if (selectedIsDefer) {
                    onDefer();
                  } else if (selectedOptionId) {
                    onSubmit(selectedOptionId, selectedNeedsCustomAnswer ? customAnswer.trim() : undefined);
                  }
                }}
                disabled={confirmDisabled}
              >
                {submitting ? '正在提交...' : '确定并继续'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default AgentQuestionDialog;
