// 传输层：只负责发请求、读响应、报传输层面的错。
// 不认识任何业务字段（errno / code / show_msg 都不在这一层），
// 业务语义由 createClient 的 parse / validate 钩子接入。

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

// network 请求没发出去或连接断开；timeout 本地超时；abort 调用方主动取消
// http  拿到响应但状态码不是 2xx；parse 2xx 但响应体不是预期格式
export type HttpErrorKind = 'network' | 'timeout' | 'abort' | 'http' | 'parse';

export interface HttpErrorInit {
  kind: HttpErrorKind;
  url: string;
  status?: number;
  body?: unknown;
  cause?: unknown;
}

export class HttpError extends Error {
  kind: HttpErrorKind;
  url: string;
  status: number;
  body: unknown;
  cause: unknown;

  constructor(message: string, init: HttpErrorInit) {
    super(message);
    this.name = 'HttpError';
    this.kind = init.kind;
    this.url = init.url;
    this.status = init.status ?? 0;
    this.body = init.body;
    this.cause = init.cause;
  }
}

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, unknown>;
  form?: Record<string, unknown>;
  json?: unknown;
  /** multipart/form-data 字段，用于上传文件内容 */
  multipart?: Record<string, string | Blob>;
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  parse?: (raw: string) => unknown;
}

export const DEFAULT_TIMEOUT = 15000;

// 这些查询参数是凭据：出现在错误对象里会被日志、监控、埋点原样带走。
// access_token 是开放平台的凭证字段；其余是常见别名，一并脱敏。
const CREDENTIAL_PARAMS = new Set(['access_token', 'accessToken', 'token', 'bduss', 'stoken']);

/**
 * 把 URL 里的凭据值替换成 `***`，用于错误对象与日志。
 * 只处理查询参数，路径里的凭据（理论上不存在）不动。
 */
export function redactUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return url;
  const path = url.slice(0, qIndex);
  const search = url.slice(qIndex + 1);
  if (search === '') return url;
  let changed = false;
  const pairs = search.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    if (!CREDENTIAL_PARAMS.has(key)) return pair;
    changed = true;
    return key + '=***';
  });
  return changed ? path + '?' + pairs.join('&') : url;
}

// 只丢 undefined 和 null。空字符串要保留——有些接口用空串表达「全部」或「清空」。
// 数组和对象转成 JSON 字符串，开放平台的 fsids / filelist / target 都是这个形态。
export function toSearchParams(params: Record<string, unknown>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return search;
}

export function parseJson(raw: string): unknown {
  return raw.trim() === '' ? null : JSON.parse(raw);
}

function snippet(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 80) + '...' : flat;
}

function buildUrl(url: string, query: Record<string, unknown> | undefined): string {
  const search = toSearchParams(query ?? {}).toString();
  if (search === '') return url;
  return url + (url.includes('?') ? '&' : '?') + search;
}

function buildInit(options: RequestOptions): RequestInit {
  const { method = 'GET', form, json, multipart, headers } = options;
  const init: RequestInit = { method, headers: { ...headers } };
  if (multipart) {
    // 不能自己设 Content-Type：boundary 要由 fetch 生成，手写一定对不上
    const body = new FormData();
    for (const [key, value] of Object.entries(multipart)) body.append(key, value);
    init.body = body;
  } else if (form) {
    // URLSearchParams 作为 body 时 fetch 会自动带上 x-www-form-urlencoded
    init.body = toSearchParams(form);
  } else if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { 'Content-Type': 'application/json', ...headers };
  }
  return init;
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, signal, parse = parseJson } = options;
  const target = buildUrl(url, options.query);
  // 错误对象与日志里只放脱敏后的地址：token 在查询串里，不能随错误外泄。
  const safeUrl = redactUrl(target);

  // 已经取消的 signal 不会触发 addEventListener，必须显式拦一次，否则照样发请求。
  if (signal?.aborted) throw new HttpError('请求已取消', { kind: 'abort', url: safeUrl });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    let response: Response;
    try {
      response = await fetch(target, { ...buildInit(options), signal: controller.signal });
    } catch (error) {
      if (timedOut)
        throw new HttpError('请求超时（' + timeout + 'ms）', { kind: 'timeout', url: safeUrl });
      if (signal?.aborted) throw new HttpError('请求已取消', { kind: 'abort', url: safeUrl });
      throw new HttpError('网络请求失败', { kind: 'network', url: safeUrl, cause: error });
    }

    // 读响应体也可能失败（连接中途断开、超时取消），这同样属于传输层问题，
    // 不包起来的话会漏出一个裸 TypeError / DOMException，调用方按 HttpError 分流会漏接。
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      if (timedOut)
        throw new HttpError('请求超时（' + timeout + 'ms）', {
          kind: 'timeout',
          url: safeUrl,
          cause: error
        });
      if (signal?.aborted)
        throw new HttpError('请求已取消', { kind: 'abort', url: safeUrl, cause: error });
      throw new HttpError('读取响应失败', { kind: 'network', url: safeUrl, cause: error });
    }

    if (!response.ok) {
      let body: unknown = raw;
      try {
        body = parse(raw);
      } catch {
        /* 错误响应体可能根本不是 JSON，原样带上就行 */
      }
      throw new HttpError('HTTP ' + response.status, {
        kind: 'http',
        url: safeUrl,
        status: response.status,
        body
      });
    }

    // 2xx 必须能解析。静态托管的 SPA 兜底会用 200 返回 index.html，
    // 不在这里拦住的话，代理配错会表现成「接口调用成功但数据为空」，非常难查。
    try {
      return parse(raw) as T;
    } catch (error) {
      throw new HttpError('响应不是合法 JSON：' + snippet(raw), {
        kind: 'parse',
        url: safeUrl,
        status: response.status,
        body: raw,
        cause: error
      });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
