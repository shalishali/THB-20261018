// 忠实移植自 client/electron/utils/aiRequestQueue.cjs（纯逻辑）。
// 并发限流 + 作用域暂停 + 内建可重试错误退避重试。
import {
  AI_REQUEST_MAX_ATTEMPTS,
  getAiRetryDelayMs,
  isRetryableAiRequestError,
} from './retry';

export const AI_QUEUE_SCOPE_PAUSED = 'AI_QUEUE_SCOPE_PAUSED';

export function createQueueScopePausedError(): Error {
  const error: any = new Error('AI 请求队列已暂停');
  error.code = AI_QUEUE_SCOPE_PAUSED;
  return error;
}

function normalizeLimit(value: any, fallback = 10): number {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? Math.round(number) : fallback);
}

export interface AiRequestQueueOptions {
  limit?: number;
  defaultLimit?: number;
  getLimit?: () => any;
  /** 排队等待多久后开始通过 onQueueWait 上报（默认 5000ms；测试可调小） */
  waitNotifyMs?: number;
}

export interface QueueStatus {
  active: number;
  queued: number;
  retrying: number;
  limit: number;
  pausedScopes: string[];
}

// 排队等待快照：请求入队后超过 waitNotifyMs 仍未获得执行权时，通过 onQueueWait 周期上报。
// 用途：任务侧在任务日志里显示「AI 请求排队中」，避免多项目并发抢占全局并发池时
// 长时间 0% 进度被误判为卡死。
export interface AiQueueWaitInfo {
  /** 当前请求在队列中的位置（1 = 下一个执行） */
  position: number;
  /** 排在前面的请求数 */
  ahead: number;
  /** 正在执行的全局并发数（含其他项目/用户的请求） */
  active: number;
  /** 队列中排队的请求总数 */
  queued: number;
  /** 全局并发上限 */
  limit: number;
}

export function createAiRequestQueue(options: AiRequestQueueOptions = {}) {
  let activeCount = 0;
  const queue: any[] = [];
  const retryingJobs = new Set<any>();
  const pausedScopes = new Set<string>();
  const getLimit = typeof options.getLimit === 'function'
    ? options.getLimit
    : () => options.limit || 10;
  const fallbackLimit = normalizeLimit(options.defaultLimit, 10);
  const waitNotifyMs = (() => {
    const raw = Number(options.waitNotifyMs);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 5000;
  })();

  function currentLimit(): number {
    try {
      return normalizeLimit(getLimit(), fallbackLimit);
    } catch {
      return fallbackLimit;
    }
  }

  function clearWaitNotify(job: any): void {
    if (job.waitNotifyTimer) {
      clearInterval(job.waitNotifyTimer);
      job.waitNotifyTimer = null;
    }
  }

  // 请求仍在队列中等待时，周期上报队列快照；获得执行权 / 被丢弃后停止。
  // 定时器 unref：纯通知用途，不阻止进程退出。
  function armWaitNotify(job: any): void {
    if (typeof job.onQueueWait !== 'function' || job.waitNotifyTimer) {
      return;
    }
    const timer = setInterval(() => {
      if (job.started) {
        clearWaitNotify(job);
        return;
      }
      const position = queue.indexOf(job) + 1;
      if (position <= 0) {
        clearWaitNotify(job);
        return;
      }
      try {
        job.onQueueWait({ position, ahead: position - 1, active: activeCount, queued: queue.length, limit: currentLimit() });
      } catch {
        // 通知失败不影响排队本身
      }
    }, waitNotifyMs);
    (timer as any).unref?.();
    job.waitNotifyTimer = timer;
  }

  function rejectIfPaused(job: any): boolean {
    if (!job.scopeId || !pausedScopes.has(job.scopeId)) {
      return false;
    }
    clearWaitNotify(job);
    job.reject(createQueueScopePausedError());
    return true;
  }

  function pump(): void {
    while (activeCount < currentLimit() && queue.length) {
      const job = queue.shift();
      if (rejectIfPaused(job)) {
        continue;
      }
      activeCount += 1;
      void runJob(job);
    }
  }

  function scheduleRetry(job: any): void {
    retryingJobs.add(job);
    job.retryTimer = setTimeout(() => {
      retryingJobs.delete(job);
      job.retryTimer = null;
      job.started = false;
      clearWaitNotify(job);
      if (!rejectIfPaused(job)) {
        queue.push(job);
        pump();
        if (!job.started) {
          armWaitNotify(job);
        }
      }
    }, getAiRetryDelayMs(job.attempts - 1, job.lastError));
  }

  async function runJob(job: any): Promise<void> {
    job.started = true;
    clearWaitNotify(job);
    try {
      if (rejectIfPaused(job)) {
        return;
      }
      const result = await job.runner({ attempt: job.attempts, maxAttempts: AI_REQUEST_MAX_ATTEMPTS });
      job.resolve(result);
    } catch (error: any) {
      if (isRetryableAiRequestError(error) && job.attempts < AI_REQUEST_MAX_ATTEMPTS) {
        job.attempts += 1;
        job.lastError = error;
        scheduleRetry(job);
      } else {
        job.reject(error);
      }
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      pump();
    }
  }

  function enqueue<T>(runner: (ctx: { attempt: number; maxAttempts: number }) => Promise<T>, options: { scopeId?: string; queueScopeId?: string; onQueueWait?: (info: AiQueueWaitInfo) => void } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = {
        runner,
        resolve,
        reject,
        scopeId: String(options.scopeId || options.queueScopeId || '').trim(),
        attempts: 1,
        retryTimer: null as (ReturnType<typeof setTimeout> | null),
        started: false,
        waitNotifyTimer: null as (ReturnType<typeof setInterval> | null),
        onQueueWait: typeof options.onQueueWait === 'function' ? options.onQueueWait : null,
      };
      if (rejectIfPaused(job)) {
        return;
      }
      queue.push(job);
      pump();
      // pump 未立即执行（并发已满）→ 请求进入等待，超过 waitNotifyMs 后开始上报排队快照
      if (!job.started) {
        armWaitNotify(job);
      }
    });
  }

  function pauseScope(scopeId: string): number {
    const normalizedScopeId = String(scopeId || '').trim();
    if (!normalizedScopeId) {
      return 0;
    }
    pausedScopes.add(normalizedScopeId);
    let discarded = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const job = queue[index];
      if (job.scopeId !== normalizedScopeId) {
        continue;
      }
      queue.splice(index, 1);
      clearWaitNotify(job);
      job.reject(createQueueScopePausedError());
      discarded += 1;
    }
    for (const job of Array.from(retryingJobs)) {
      if (job.scopeId !== normalizedScopeId) {
        continue;
      }
      retryingJobs.delete(job);
      if (job.retryTimer) {
        clearTimeout(job.retryTimer);
        job.retryTimer = null;
      }
      clearWaitNotify(job);
      job.reject(createQueueScopePausedError());
      discarded += 1;
    }
    return discarded;
  }

  function resumeScope(scopeId: string): void {
    const normalizedScopeId = String(scopeId || '').trim();
    if (normalizedScopeId) {
      pausedScopes.delete(normalizedScopeId);
    }
  }

  function getStatus(): QueueStatus {
    return {
      active: activeCount,
      queued: queue.length,
      retrying: retryingJobs.size,
      limit: currentLimit(),
      pausedScopes: [...pausedScopes],
    };
  }

  return { enqueue, pauseScope, resumeScope, getStatus };
}
