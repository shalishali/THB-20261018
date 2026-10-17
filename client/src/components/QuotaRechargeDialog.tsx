// 字数额度充值弹窗（应用级单例，挂 AppShell）。
// 打开方式：顶栏额度 chip、导出 402（quota:insufficient 事件，携带不足详情自动定位）。
// 支付网关（支付宝/微信）接入前：创建订单后停留在 pending，由管理员在后台人工核验入账；
// gatewayReady=true 时后续替换为真正的扫码/跳转支付。
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  QUOTA_INSUFFICIENT_EVENT,
  QUOTA_OPEN_DIALOG_EVENT,
  createQuotaOrder,
  fetchQuota,
  formatAmountCents,
  formatQuotaChars,
  listQuotaOrders,
  type QuotaInsufficientDetail,
  type QuotaOrderInfo,
  type QuotaPlan,
} from '../shared/api/quota';

type Channel = 'alipay' | 'wechat';

const CHANNEL_TABS: Array<{ key: Channel; label: string }> = [
  { key: 'alipay', label: '支付宝' },
  { key: 'wechat', label: '微信支付' },
];

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已入账',
  closed: '已关闭',
};

function QuotaRechargeDialog() {
  const [open, setOpen] = useState(false);
  const [insufficient, setInsufficient] = useState<QuotaInsufficientDetail | null>(null);
  const [plans, setPlans] = useState<QuotaPlan[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [selectedPlanKey, setSelectedPlanKey] = useState<string>('');
  const [channel, setChannel] = useState<Channel>('alipay');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>('');
  const [createdOrder, setCreatedOrder] = useState<QuotaOrderInfo | null>(null);
  const [orders, setOrders] = useState<QuotaOrderInfo[]>([]);

  const loadPlans = useCallback(async () => {
    try {
      const data = await fetchQuota();
      setPlans(data.plans || []);
      setBalance(data.quotaChars);
      if (data.plans?.length && !data.plans.some((plan) => plan.key === selectedPlanKey)) {
        setSelectedPlanKey(data.plans[0].key);
      }
    } catch {
      /* 打开时静默失败，提交时再报错 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const data = await listQuotaOrders();
      setOrders(data.orders || []);
    } catch {
      /* 列表失败不阻断充值主流程 */
    }
  }, []);

  useEffect(() => {
    const openHandler = () => { setInsufficient(null); setOpen(true); };
    const insufficientHandler = (event: Event) => {
      const detail = (event as CustomEvent<QuotaInsufficientDetail>).detail || null;
      setInsufficient(detail);
      if (detail?.plans?.length) {
        setPlans(detail.plans);
        if (!detail.plans.some((plan) => plan.key === selectedPlanKey)) setSelectedPlanKey(detail.plans[0].key);
      }
      setOpen(true);
    };
    window.addEventListener(QUOTA_OPEN_DIALOG_EVENT, openHandler);
    window.addEventListener(QUOTA_INSUFFICIENT_EVENT, insufficientHandler);
    return () => {
      window.removeEventListener(QUOTA_OPEN_DIALOG_EVENT, openHandler);
      window.removeEventListener(QUOTA_INSUFFICIENT_EVENT, insufficientHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    setCreatedOrder(null);
    setError('');
    void loadPlans();
    void loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedPlan = plans.find((plan) => plan.key === selectedPlanKey) || null;

  const submitOrder = async () => {
    if (!selectedPlan || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await createQuotaOrder(selectedPlan.key, channel);
      setCreatedOrder(result.order);
      void loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建订单失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="quota-dialog-overlay" />
        <Dialog.Content className="quota-dialog" aria-describedby={undefined}>
          <div className="quota-dialog-head">
            <Dialog.Title>字数额度充值</Dialog.Title>
            <Dialog.Close className="quota-dialog-close" aria-label="关闭">×</Dialog.Close>
          </div>

          {insufficient && (
            <div className="quota-insufficient-banner">
              <span>
                ⚠ 字数额度不足：本次导出需要 <strong>{formatQuotaChars(insufficient.required)}</strong>，
                当前余额 <strong>{formatQuotaChars(insufficient.balance)}</strong>，
                还差 <strong>{formatQuotaChars(Math.max(0, insufficient.required - insufficient.balance))}</strong>。请选择套餐充值后再导出。
              </span>
            </div>
          )}

          <div className="quota-plan-grid">
            {plans.map((plan) => (
              <button
                type="button"
                key={plan.key}
                className={`quota-plan-card${plan.key === selectedPlanKey ? ' is-selected' : ''}`}
                onClick={() => setSelectedPlanKey(plan.key)}
              >
                <strong>{plan.label}</strong>
                <em>{formatAmountCents(plan.amountCents)}</em>
              </button>
            ))}
            {!plans.length && <div className="quota-plan-empty">套餐加载中…</div>}
          </div>

          <div className="quota-channel-tabs">
            {CHANNEL_TABS.map((tab) => (
              <button
                type="button"
                key={tab.key}
                className={`quota-channel-tab${channel === tab.key ? ' is-selected' : ''}`}
                onClick={() => setChannel(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {createdOrder ? (
            <div className="quota-order-result">
              <p>订单已创建：<strong>{createdOrder.outTradeNo}</strong></p>
              <p>{formatQuotaChars(createdOrder.chars)} · {formatAmountCents(createdOrder.amountCents)} · {STATUS_LABEL[createdOrder.status] || createdOrder.status}</p>
              <p className="quota-order-note">支付网关接入完成后，此处将展示{channel === 'alipay' ? '支付宝' : '微信'}扫码支付。已线下付款的订单由管理员核验后自动到账。</p>
            </div>
          ) : (
            <button
              type="button"
              className="primary-action quota-submit"
              onClick={() => { void submitOrder(); }}
              disabled={!selectedPlan || submitting}
            >
              {submitting ? '创建订单中…' : selectedPlan ? `立即充值 ${selectedPlan.label}（${formatAmountCents(selectedPlan.amountCents)}）` : '立即充值'}
            </button>
          )}
          {error && <p className="quota-error">{error}</p>}

          <div className="quota-orders">
            <strong>近期订单</strong>
            {orders.length ? (
              <ul>
                {orders.map((order) => (
                  <li key={order.id}>
                    <span>{new Date(order.createdAt).toLocaleString()}</span>
                    <span>{formatQuotaChars(order.chars)}</span>
                    <span>{formatAmountCents(order.amountCents)}</span>
                    <em className={`quota-order-status is-${order.status}`}>{STATUS_LABEL[order.status] || order.status}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quota-orders-empty">暂无订单</p>
            )}
          </div>

          {/* 客服信息 */}
          <div className="quota-customer-service">
            <span>📱 客服电话：<a href="tel:17341418824"><strong>17341418824</strong></a></span>
            <span>期待您的咨询，我们将尽快为您解答！</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default QuotaRechargeDialog;
