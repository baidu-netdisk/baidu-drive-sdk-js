// 客户端工厂：把「上游地址 + 凭证来源 + 响应解释」做成可注入的配置。
// 一个上游一个 client，凭证靠 getToken 注进来，不在这里碰 localStorage。

import { request } from './transport';
import type { RequestOptions } from './transport';

// 配置缺失（没填 token、没配 baseUrl）是写码/配置问题，
// 和网络失败分开，调用方才能分流处理。
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ClientConfig {
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  /** 凭证来源，返回空串视为未登录 */
  getToken?: () => string;
  /** 凭证放 query 的字段名，开放平台用 access_token */
  tokenParam?: string;
  /** 凭证放 header 的字段名，值直接用 getToken 的返回 */
  tokenHeader?: string;
  /** 配了凭证通道但拿不到凭证时是否报错，默认 true */
  requireToken?: boolean;
  parse?: (raw: string) => unknown;
  /** 业务语义校验，解析成功后调用，不满足就自己抛 */
  validate?: (data: unknown, url: string) => void;
}

export interface HttpClient {
  readonly config: ClientConfig;
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  get: <T>(path: string, query?: Record<string, unknown>, options?: RequestOptions) => Promise<T>;
  post: <T>(path: string, form?: Record<string, unknown>, options?: RequestOptions) => Promise<T>;
}

export function createClient(config: ClientConfig = {}): HttpClient {
  const hasTokenChannel = config.tokenParam !== undefined || config.tokenHeader !== undefined;

  function resolveToken(): string {
    if (!hasTokenChannel) return '';
    const token = config.getToken?.() ?? '';
    if (token === '' && config.requireToken !== false) {
      throw new ConfigError('缺少访问凭证，请先完成授权或填入 token');
    }
    return token;
  }

  async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = resolveToken();
    const query = { ...options.query };
    const headers = { ...config.headers, ...options.headers };

    if (token !== '') {
      if (config.tokenParam !== undefined) query[config.tokenParam] = token;
      else if (config.tokenHeader !== undefined) headers[config.tokenHeader] = token;
    }

    const url = (config.baseUrl ?? '') + path;
    const data = await request<T>(url, {
      ...options,
      query,
      headers,
      timeout: options.timeout ?? config.timeout,
      parse: options.parse ?? config.parse
    });

    config.validate?.(data, url);
    return data;
  }

  return {
    config,
    request: send,
    get: (path, query, options) => send(path, { ...options, method: 'GET', query }),
    post: (path, form, options) => send(path, { ...options, method: 'POST', form })
  };
}
