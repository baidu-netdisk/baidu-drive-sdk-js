import { describe, expect, it, vi } from 'vitest';

import { HttpError } from './transport';
import { ApiError } from './openapi';
import { isRetryableError, withRetry } from './retry';

function apiError(errno: number): ApiError {
  return new ApiError('boom', { errno, requestId: '1', url: '/x', payload: null });
}

function httpError(
  kind: 'network' | 'timeout' | 'http' | 'parse' | 'abort',
  status = 0
): HttpError {
  return new HttpError('boom', { kind, url: '/x', status });
}

describe('可重试判定', () => {
  it('只有「下次可能行」的错误才重试', () => {
    expect(isRetryableError(httpError('network'))).toBe(true);
    expect(isRetryableError(httpError('timeout'))).toBe(true);
    expect(isRetryableError(httpError('http', 503))).toBe(true);
    expect(isRetryableError(apiError(31034))).toBe(true);
  });

  it('重试多少次结果都一样的错误不重试', () => {
    expect(isRetryableError(apiError(-6))).toBe(false); // token 失效，要重新授权
    expect(isRetryableError(apiError(-9))).toBe(false); // 路径真的不存在
    expect(isRetryableError(httpError('http', 400))).toBe(false);
    expect(isRetryableError(httpError('parse'))).toBe(false);
    expect(isRetryableError(httpError('abort'))).toBe(false);
    expect(isRetryableError(new Error('普通错误'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('第一次就成功时不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('瞬时错误重试到成功', async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError('network')).mockResolvedValue('ok');
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('不可重试的错误立刻抛出，不浪费配额', async () => {
    const fn = vi.fn().mockRejectedValue(apiError(-9));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('用尽次数后抛最后一次的错误', async () => {
    const fn = vi.fn().mockRejectedValue(httpError('timeout'));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('退避是确定的指数序列 base * 2^n', async () => {
    vi.useFakeTimers();
    try {
      const delays: number[] = [];
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: () => void,
        ms: number
      ) => {
        delays.push(ms);
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError('network'))
        .mockRejectedValueOnce(httpError('network'))
        .mockResolvedValue('ok');
      await withRetry(fn, { attempts: 3, baseDelayMs: 300 });
      expect(delays).toEqual([300, 600]);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('外部 signal 取消时中断重试等待', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(httpError('network'));
    const pending = withRetry(fn, { attempts: 5, baseDelayMs: 50, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('重试已取消');
  });
});

describe('取消信号', () => {
  it('进入重试前就已取消时不执行任务', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          return 1;
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ kind: 'abort' });

    expect(calls).toBe(0);
  });
});
