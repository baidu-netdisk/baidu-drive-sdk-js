// 重试：只重试「这次不行、下次可能行」的错误。
// errno -6（token 失效）、-9（路径不存在）这类重试多少次结果都一样，不该重试。

import { HttpError } from './transport';
import { ApiError } from './openapi';

/**
 * 31034 命中频率控制、111 有其他异步任务正在执行，
 * 这两个都是「隔一会儿再试有意义」的
 */
const RETRYABLE_ERRNO = new Set([31034, 111]);

export interface RetryOptions {
  /** 总尝试次数，含第一次，默认 3 */
  attempts?: number;
  /** 退避基数毫秒，默认 300，第 n 次等待 base * 2^(n-1) */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** 覆盖默认的可重试判定 */
  isRetryable?: (error: unknown) => boolean;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_ERRNO.has(error.errno);
  if (error instanceof HttpError) {
    if (error.kind === 'network' || error.kind === 'timeout') return true;
    // 5xx 是服务端临时问题；4xx 和 parse 重试没意义
    return error.kind === 'http' && error.status >= 500;
  }
  return false;
}

function abortError(): HttpError {
  return new HttpError('重试已取消', { kind: 'abort', url: '' });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // 必须先查一次已有状态：signal 在挂监听之前就已经 abort 的话，
  // addEventListener('abort') 永远不会触发，会白等一个退避周期。
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true }
    );
  });
}

// 退避不加随机抖动：固定序列才能写出可断言的测试。
// 真出现惊群再加，届时把抖动做成可注入的。
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const retryable = options.isRetryable ?? isRetryableError;

  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    // 每次尝试前都看一眼：调用方可能在等待退避期间取消了，这时不该再发请求。
    if (options.signal?.aborted) throw abortError();
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1 || !retryable(error)) throw error;
      await sleep(baseDelayMs * 2 ** i, options.signal);
    }
  }
  throw lastError;
}
