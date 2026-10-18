// Agent 单飞门闩 + FIFO 排队队列（opencode / pi 两个 runtime 共用）。
//
// 背景：sidecar / AI Proxy 是进程级单实例，同一时刻只允许一个 Agent 任务执行（单飞契约）。
// Web 多项目场景下，跨项目任务会在 runTask 入口撞车；此前直接返回 busy 哨兵（任务失败、需手动重试）。
// 本模块把「立即 busy」升级为「FIFO 排队等待」：
//  - acquire：空闲时立即持锁；被占用时入队等待，release 时锁直接移交给队首（新的直通调用不会插队）。
//  - 容量满 / 排队超时：返回对应 outcome，由调用方回退 busy 哨兵（保留旧的降级契约）。
//  - 支持 AbortSignal：排队中被取消的任务立即出队，不占用后续槽位。
//  - close：清空队列（服务关闭时所有等待者立即得到 closed）。
//
// 容量 / 等待上限可用环境变量覆盖：
//  - YIBIAO_AGENT_QUEUE_MAX（默认 4）
//  - YIBIAO_AGENT_QUEUE_WAIT_MS（默认 15 分钟）

import crypto from 'node:crypto';
import type { AgentQueuedTaskInfo } from './types';

export type AgentSlotAcquireOutcome = 'acquired' | 'queue-full' | 'timeout' | 'aborted' | 'closed';

export interface AgentSlotAcquireOptions {
  title?: string;
  signal?: AbortSignal;
}

export interface AgentSlotQueueOptions {
  maxQueued?: number;
  waitTimeoutMs?: number;
  onStatusChange?: () => void;
}

interface AgentSlotWaiter {
  taskId: string;
  title: string;
  queuedAt: string;
  signal: AbortSignal | null;
  timer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
  resolve: (outcome: AgentSlotAcquireOutcome) => void;
}

function readPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_MAX_QUEUED = readPositiveEnvInt('YIBIAO_AGENT_QUEUE_MAX', 4);
const DEFAULT_WAIT_TIMEOUT_MS = readPositiveEnvInt('YIBIAO_AGENT_QUEUE_WAIT_MS', 15 * 60 * 1000);

export class AgentSlotQueue {
  private readonly maxQueued: number;
  private readonly waitTimeoutMs: number;
  private readonly onStatusChange: (() => void) | null;
  private locked = false;
  private closed = false;
  private waiters: AgentSlotWaiter[] = [];

  constructor(options: AgentSlotQueueOptions = {}) {
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.onStatusChange = options.onStatusChange ?? null;
  }

  get size(): number {
    return this.waiters.length;
  }

  getStats(): AgentQueuedTaskInfo[] {
    return this.waiters.map((waiter, index) => ({
      task_id: waiter.taskId,
      title: waiter.title,
      queued_at: waiter.queuedAt,
      position: index + 1,
    }));
  }

  async acquire(options: AgentSlotAcquireOptions = {}): Promise<AgentSlotAcquireOutcome> {
    if (this.closed) return 'closed';
    if (options.signal?.aborted) return 'aborted';
    if (!this.locked) {
      this.locked = true;
      return 'acquired';
    }
    if (this.waiters.length >= this.maxQueued) return 'queue-full';
    const signal = options.signal ?? null;
    return await new Promise<AgentSlotAcquireOutcome>((resolve) => {
      const waiter: AgentSlotWaiter = {
        taskId: `agent-queue-${crypto.randomUUID()}`,
        title: options.title || '未命名 Agent 任务',
        queuedAt: new Date().toISOString(),
        signal,
        timer: null,
        onAbort: null,
        resolve,
      };
      this.waiters.push(waiter);
      waiter.timer = setTimeout(() => {
        if (this.removeWaiter(waiter)) resolve('timeout');
      }, this.waitTimeoutMs);
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => {
          if (this.removeWaiter(waiter)) resolve('aborted');
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.notifyStatusChange();
    });
  }

  release(): void {
    if (this.closed) return;
    this.locked = false;
    this.handOffToNext();
  }

  close(): void {
    this.closed = true;
    this.locked = false;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      this.detachWaiter(waiter);
      waiter.resolve('closed');
    }
    if (pending.length > 0) this.notifyStatusChange();
  }

  private handOffToNext(): void {
    const next = this.waiters.shift();
    if (!next) return;
    // 锁直接移交给队首等待者：防止 release 之后、等待者微任务恢复之前，被新的直通调用插队。
    this.locked = true;
    this.detachWaiter(next);
    next.resolve('acquired');
    this.notifyStatusChange();
  }

  private removeWaiter(waiter: AgentSlotWaiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    this.detachWaiter(waiter);
    this.notifyStatusChange();
    return true;
  }

  private detachWaiter(waiter: AgentSlotWaiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = null;
    }
  }

  private notifyStatusChange(): void {
    try {
      this.onStatusChange?.();
    } catch {
      /* 状态回调异常不影响队列 */
    }
  }
}
