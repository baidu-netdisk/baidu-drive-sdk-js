import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  DEFAULT_BASE_URL,
  apiErrno,
  assertOpenApiOk,
  createLocalStorageTokenStore,
  createMemoryTokenStore,
  createOpenApi,
  parseOpenApiBody
} from './index';
import { LIST_FILES } from './endpoints';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenApi', () => {
  it('默认 baseUrl 是同源前缀 /pan，不依赖任何构建工具的 env', () => {
    expect(DEFAULT_BASE_URL).toBe('/pan');
    expect(createOpenApi().client.config.baseUrl).toBe('/pan');
  });

  it('baseUrl 可以覆盖（换成别的前缀，或同源部署时传空串）', () => {
    expect(createOpenApi({ baseUrl: '/pcs' }).client.config.baseUrl).toBe('/pcs');
    expect(createOpenApi({ baseUrl: '' }).client.config.baseUrl).toBe('');
  });

  it('把 token 放进 access_token 查询参数，并把解析后的响应交给调用方', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"errno":0,"list":[]}', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = createOpenApi({
      baseUrl: '/pan',
      tokenStore: createMemoryTokenStore('tok-1')
    });
    const listFiles = api.defineApi(LIST_FILES);

    await listFiles({ dir: '/', start: 0, limit: 10 });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith('/pan/rest/2.0/xpan/file?')).toBe(true);
    expect(url).toContain('access_token=tok-1');
    expect(url).toContain('method=list');
    expect(url).toContain('start=0');
  });

  it('没有可用凭证时抛 ConfigError，而不是拿空 token 去打接口', async () => {
    const api = createOpenApi({ baseUrl: '/pan', tokenStore: createMemoryTokenStore() });
    await expect(api.defineApi(LIST_FILES)({ dir: '/' })).rejects.toThrow(/缺少访问凭证/);
  });

  it('errno 非 0 时抛 ApiError，并带上 request_id 与接口原文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"errno":-6,"show_msg":"Invalid Bduss","request_id":7790000000000000001}', {
            status: 200
          })
      )
    );
    const api = createOpenApi({ baseUrl: '/pan', tokenStore: createMemoryTokenStore('tok') });

    const error = await api
      .defineApi(LIST_FILES)({ dir: '/' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.errno).toBe(-6);
    expect(apiError.errmsg).toBe('Invalid Bduss');
    // request_id 超出 MAX_SAFE_INTEGER，必须按字符串原样保留才不影响排查
    expect(apiError.requestId).toBe('7790000000000000001');
    expect(apiErrno(apiError)).toBe(-6);
  });
});

describe('parseOpenApiBody', () => {
  it('把超大整数形式的 request_id 转成字符串，其余字段保持原样', () => {
    const parsed = parseOpenApiBody('{"errno":0,"request_id":7790000000000000001,"n":1}') as {
      request_id: string;
      n: number;
    };
    expect(parsed.request_id).toBe('7790000000000000001');
    expect(parsed.n).toBe(1);
  });

  it('空响应体解析成 null，而不是抛 JSON 错误', () => {
    expect(parseOpenApiBody('   ')).toBeNull();
  });
});

describe('assertOpenApiOk', () => {
  it('errno 为 0 时放行', () => {
    expect(() => assertOpenApiOk({ errno: 0 }, '/x')).not.toThrow();
  });

  it('非对象响应（比如二进制流）直接放行，交给调用方处理', () => {
    expect(() => assertOpenApiOk(null, '/x')).not.toThrow();
    expect(() => assertOpenApiOk('raw', '/x')).not.toThrow();
  });

  it('错误的业务码优先用收录的中文文案，接口原文留在 errmsg 上', () => {
    const error = (() => {
      try {
        assertOpenApiOk({ errno: 31034, show_msg: 'too many requests' }, '/x');
      } catch (e) {
        return e as ApiError;
      }
      return null;
    })();
    expect(error?.message).toBe('命中接口频控，请降低请求频率');
    expect(error?.errmsg).toBe('too many requests');
  });
});

describe('createLocalStorageTokenStore', () => {
  it('没有 localStorage 的环境退化成内存存储，不抛错', () => {
    // Node 测试环境没有 localStorage（happy-dom 的用例里才有），这里断言退化行为
    const store = createLocalStorageTokenStore('k');
    expect(store.get()).toBe('');
    store.set(' abc ');
    expect(store.get()).toBe('abc');
    store.clear();
    expect(store.get()).toBe('');
  });
});
