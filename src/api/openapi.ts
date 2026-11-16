// 网盘开放平台适配层：凭证怎么存、响应怎么解析、errno 怎么解释，都收在这里。
// 换成别的上游（自己的服务、第三方 API）时不要改这个文件，直接 createClient 另建一个。

import { createClient } from './client';
import { errnoMessage, hasErrnoMessage } from './errno';
import { parseJson } from './transport';
import type { HttpClient } from './client';
import type { HttpMethod, RequestOptions } from './transport';

export interface TokenStore {
  get: () => string;
  set: (token: string) => void;
  clear: () => void;
}

export function createMemoryTokenStore(initial = ''): TokenStore {
  let token = initial;
  return {
    get: () => token,
    set: (value) => {
      token = value.trim();
    },
    clear: () => {
      token = '';
    }
  };
}

// 没有 localStorage 的环境（Node、测试）自动退化成内存存储，
// 这样这个模块不需要伪造浏览器就能跑。
export function createLocalStorageTokenStore(key: string): TokenStore {
  if (typeof localStorage === 'undefined') return createMemoryTokenStore();
  return {
    get: () => localStorage.getItem(key) ?? '',
    set: (value) => localStorage.setItem(key, value.trim()),
    clear: () => localStorage.removeItem(key)
  };
}

// request_id 超过 Number.MAX_SAFE_INTEGER，直接 JSON.parse 会丢末位，排查时就对不上平台日志。
// lookahead 不能省：部分接口返回 7.79e+16 这种科学计数法，只改整数形式才不会把 JSON 改坏。
export function parseOpenApiBody(raw: string): unknown {
  return parseJson(raw.replace(/"request_id":\s*(\d+)(?=[,}\s])/g, '"request_id":"$1"'));
}

export interface ApiErrorInit {
  errno: number;
  requestId: string;
  url: string;
  payload: unknown;
  /** 接口原文，可能是英文或空 */
  errmsg?: string;
}

export class ApiError extends Error {
  errno: number;
  requestId: string;
  url: string;
  payload: unknown;
  errmsg: string;

  constructor(message: string, init: ApiErrorInit) {
    super(message);
    this.name = 'ApiError';
    this.errno = init.errno;
    this.requestId = init.requestId;
    this.url = init.url;
    this.payload = init.payload;
    this.errmsg = init.errmsg ?? '';
  }
}

// 开放平台失败时同样返回 HTTP 200，业务码在 errno 上；错误文案的字段名各接口不统一。
// message 优先用我们自己维护的中文说明：接口原文经常是 'Invalid Bduss' 这类
// 没法直接给用户看的内容。原文保留在 errmsg 上，排查时还能对上平台日志。
export function assertOpenApiOk(data: unknown, url: string): void {
  if (data === null || typeof data !== 'object') return;
  const body = data as Record<string, unknown>;
  const errno = Number(body.errno ?? body.error_code ?? 0);
  if (errno === 0) return;

  const raw = body.show_msg ?? body.errmsg ?? body.error_msg ?? body.error_description;
  const errmsg = raw === undefined ? '' : String(raw);
  const message = hasErrnoMessage(errno) ? errnoMessage(errno) : errmsg || errnoMessage(errno);
  throw new ApiError(message, {
    errno,
    requestId: body.request_id === undefined ? '' : String(body.request_id),
    url,
    payload: data,
    errmsg
  });
}

// 与接口文档的「请求结构」表格一一对应：
// method -> HTTP Method，path -> HTTP URL 去掉域名的部分，fixedQuery -> 固定查询参数
//
// 端点描述是纯数据，不含 client，所以可以被任意多个 app / 账号共用。
// 要变成可调用的函数，得用某个 OpenApi 实例 bind 一下（见 defineApi）。
export interface ApiDescriptor<P extends object = object, R = unknown> {
  method?: HttpMethod;
  path: string;
  fixedQuery?: Record<string, string>;
  /**
   * 业务参数放哪：query 或表单体。
   * 默认 GET 放 query、POST 放表单体；上传类接口是 POST 但参数在 query、
   * 体留给文件内容，这时显式写 'query'。
   */
  paramsIn?: 'query' | 'form';
  /** 只用于携带参数和返回值类型，运行时不存在 */
  types?: (params: P) => R;
}

/** 声明一个端点描述，把参数和返回值类型带上，bind 的时候就不用再写一遍泛型 */
export function describeApi<P extends object, R>(
  descriptor: Omit<ApiDescriptor<P, R>, 'types'>
): ApiDescriptor<P, R> {
  return descriptor as ApiDescriptor<P, R>;
}

// 业务错误码有两种载体：HTTP 200 + errno（ApiError），以及非 2xx + error_code（HttpError.body）。
// 实测 method=meta 查不存在的路径返回的是 HTTP 404 + error_code 31066，不是 200 + errno。
// 调用方要按错误码分流（比如把「文件不存在」当正常分支）时用这个取值，不要自己摸 body。
export function apiErrno(error: unknown): number {
  if (error === null || typeof error !== 'object') return 0;
  const fields = error as { errno?: unknown; body?: unknown };
  if (typeof fields.errno === 'number') return fields.errno;
  if (fields.body === null || typeof fields.body !== 'object') return 0;
  const body = fields.body as Record<string, unknown>;
  return Number(body.errno ?? body.error_code ?? 0);
}

/**
 * 判断错误是不是某个业务错误码。对应 Go SDK 的 `api.IsErrno(err, errno)`：
 *
 *   if (isErrno(error, Errno.AccessTokenExpired)) { ...重新授权... }
 *
 * 同时认 `ApiError.errno` 和 `HttpError.body.error_code` 两个载体。
 * 不要自己写 `error.errno === ERRNO`，那样会漏判非 2xx 的情况。
 *
 * 传进来的不是错误对象（比如 null）一律返回 false —— 否则 `isErrno(null, 0)`
 * 会因为「取不到码就当 0」而误判成成功。
 */
export function isErrno(error: unknown, errno: number): boolean {
  if (error === null || typeof error !== 'object') return false;
  return apiErrno(error) === errno;
}

export interface OpenApiConfig {
  baseUrl?: string;
  tokenStore?: TokenStore;
  timeout?: number;
}

export interface OpenApi {
  client: HttpClient;
  token: TokenStore;
  /** 把端点描述绑到本实例上，得到一个可调用的函数 */
  defineApi: <P extends object, R>(
    descriptor: ApiDescriptor<P, R>
  ) => (params?: P, options?: RequestOptions) => Promise<R>;
}

// 浏览器直连 pan.baidu.com 会被 CORS 拦掉（开放平台响应里没有 Access-Control-Allow-Origin），
// 所以默认只认同源相对前缀，由 dev server 或线上反向代理转发。
//
// 这个默认值刻意不读任何构建工具的 env（不碰 import.meta.env），
// 因为本包要能用在 Vite / Webpack / 原生 ESM 任意环境里：
//   - 前缀不叫 /pan —— 显式传 baseUrl
//   - 页面本身就跑在 pan.baidu.com 上（同源部署）—— 传 baseUrl: ''
export const DEFAULT_BASE_URL = '/pan';

export function createOpenApi(config: OpenApiConfig = {}): OpenApi {
  const token = config.tokenStore ?? createLocalStorageTokenStore('netdisk-access-token');

  const client = createClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeout: config.timeout,
    getToken: () => token.get(),
    tokenParam: 'access_token',
    parse: parseOpenApiBody,
    validate: assertOpenApiOk
  });

  function defineApi<P extends object, R>(descriptor: ApiDescriptor<P, R>) {
    const method = descriptor.method ?? 'GET';
    const paramsIn = descriptor.paramsIn ?? (method === 'GET' ? 'query' : 'form');
    return (params: P = {} as P, options: RequestOptions = {}): Promise<R> => {
      const fields = params as Record<string, unknown>;
      const fixed = { ...descriptor.fixedQuery, ...options.query };
      return client.request<R>(descriptor.path, {
        ...options,
        method,
        query: paramsIn === 'query' ? { ...fixed, ...fields } : fixed,
        form: paramsIn === 'query' ? options.form : { ...options.form, ...fields }
      });
    };
  }

  return { client, token, defineApi };
}

// 刻意不提供「默认实例」。
// 一个模块级的全局实例意味着 token 来源是全局可变状态：多个 app 或多个账号同时存在时
// 会互相覆盖，将来做 SSR 更会在 Node 进程里跨请求串号。
// 每个 app 自己 createOpenApi 一次，把 auth 的 tokenStore 传进来。
