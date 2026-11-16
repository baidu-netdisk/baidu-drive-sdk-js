import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError, redactUrl, request } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('redactUrl', () => {
  it('把凭据查询参数的值替换成 ***，其余参数原样保留', () => {
    expect(redactUrl('/pan/rest/2.0/xpan/file?method=list&access_token=SECRET&limit=10')).toBe(
      '/pan/rest/2.0/xpan/file?method=list&access_token=***&limit=10'
    );
  });

  it('没有查询串、或查询串里没有凭据时原样返回', () => {
    expect(redactUrl('/pan/rest/2.0/xpan/file')).toBe('/pan/rest/2.0/xpan/file');
    expect(redactUrl('/x?method=list&limit=1')).toBe('/x?method=list&limit=1');
  });

  it('常见凭据别名一并脱敏', () => {
    expect(redactUrl('/x?access_token=a&token=b&bduss=c&stoken=d&accessToken=e&other=f')).toBe(
      '/x?access_token=***&token=***&bduss=***&stoken=***&accessToken=***&other=f'
    );
  });
});

describe('request 的错误对象', () => {
  it('网络错误的 URL 不带 token', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });

    const error = (await request('/x', { query: { access_token: 'SECRET' } }).catch(
      (e) => e
    )) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(error.kind).toBe('network');
    expect(error.url).not.toContain('SECRET');
    expect(error.url).toContain('access_token=***');
  });

  it('已经取消的 signal 直接失败，不发出请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = (await request('/x', { signal: controller.signal }).catch((e) => e)) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(error.kind).toBe('abort');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('读响应体失败归为网络错误，不泄漏裸 TypeError', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('stream broke');
      }
    }));

    const error = (await request('/x').catch((e) => e)) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(error.kind).toBe('network');
  });

  it('超时仍然分类成 timeout', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );

    const error = (await request('/x', { timeout: 20 }).catch((e) => e)) as HttpError;

    expect(error.kind).toBe('timeout');
  });

  it('非 2xx 且响应体不是 JSON 时，body 保留原文，URL 仍脱敏', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html>bad gateway</html>'
    }));

    const error = (await request('/x', { query: { access_token: 'SECRET' } }).catch(
      (e) => e
    )) as HttpError;

    expect(error.kind).toBe('http');
    expect(error.body).toBe('<html>bad gateway</html>');
    expect(error.url).not.toContain('SECRET');
  });
});
