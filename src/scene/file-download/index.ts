// 下载场景。只做编排，端点描述在 baidu-drive-sdk-js/api（复用 FILE_METAS，不需要新端点）。
//
// 浏览器下载分两种，限制完全不同，所以这里给两套出口：
// 1. 存到本地（用户点一下，文件进下载目录）→ saveAs / downloadUrl
//    走的是浏览器导航，不受同源策略约束，不需要代理
// 2. 把字节读进 JS（预览、算校验、塞 canvas）→ fetchBlob / sameOriginUrl
//    走的是 fetch，dlink 没有 CORS 响应头，必须经同源代理
//
// 实测：dlink 不要求 User-Agent 是 pan.baidu.com，浏览器 UA 也能下
// （文档把这个头写成必填、31326 防盗链也指向它，但实际没拦）。

import { FILE_METAS, withRetry } from '../../api';
import type {
  FileMetasParams,
  FileMetasResult,
  OpenApi,
  PanFileMeta,
  RetryOptions
} from '../../api';

/** dlink 的域名，和上传域名是同一个 host */
export const DLINK_HOST = 'd.pcs.baidu.com';

export interface DownloadMeta {
  fsId: number;
  filename: string;
  path: string;
  size: number;
  md5: string;
  /** 带 access_token 的下载地址 */
  dlink: string;
}

export interface DownloadOptions {
  retry?: RetryOptions;
  signal?: AbortSignal;
}

/** 取不到 dlink。多半是 fsid 不对或没有下载权限。 */
export class DownloadError extends Error {
  fsId: number;

  constructor(message: string, fsId: number) {
    super(message);
    this.name = 'DownloadError';
    this.fsId = fsId;
  }
}

export interface FileDownloadDeps {
  fileMetas: (params?: FileMetasParams) => Promise<FileMetasResult>;
}

export interface FileDownloadConfig {
  /** 同源代理前缀，要和 vite / 线上反代里指向 d.pcs.baidu.com 的那条规则一致 */
  proxyPrefix?: string;
  /** 取 token 的方式，默认用 OpenApi 实例自带的 tokenStore */
  getToken?: () => string;
}

export interface FileDownload {
  meta: (fsId: number, options?: DownloadOptions) => Promise<DownloadMeta>;
  /** 直链，带 access_token。给 <a download> 或新开标签页用 */
  downloadUrl: (fsId: number, options?: DownloadOptions) => Promise<string>;
  /** 同源代理地址。给 fetch / <img> / <video> 用 */
  sameOriginUrl: (dlink: string) => string;
  /** 把内容读进 JS，走同源代理 */
  fetchBlob: (fsId: number, options?: DownloadOptions) => Promise<Blob>;
  /** 触发浏览器下载。需要 DOM */
  saveAs: (fsId: number, filename?: string, options?: DownloadOptions) => Promise<void>;
}

function missing(name: string) {
  return (): never => {
    throw new Error('createFileDownload 缺少端点实现：' + name);
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createFileDownload(
  source: OpenApi | Partial<FileDownloadDeps>,
  config: FileDownloadConfig = {}
): FileDownload {
  const isApi = 'defineApi' in source;
  const api: FileDownloadDeps = isApi
    ? { fileMetas: source.defineApi(FILE_METAS) }
    : { fileMetas: source.fileMetas ?? missing('fileMetas') };

  const getToken = config.getToken ?? (isApi ? () => source.token.get() : () => '');
  const proxyPrefix = config.proxyPrefix ?? '/pcs';

  // dlink 本身不带凭据，必须自己拼 access_token
  function withToken(dlink: string): string {
    const token = getToken();
    if (token === '') return dlink;
    return dlink + (dlink.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  }

  function toMeta(raw: PanFileMeta, fsId: number): DownloadMeta {
    if (!raw.dlink) {
      throw new DownloadError('接口没有返回 dlink，确认 fsid 正确且应用有下载权限', fsId);
    }
    return {
      fsId: raw.fs_id,
      filename: decode(raw.filename ?? ''),
      path: decode(raw.path ?? ''),
      size: raw.size ?? 0,
      md5: raw.md5 ?? '',
      dlink: withToken(raw.dlink)
    };
  }

  /** 取文件元信息和下载地址。dlink 有有效期，别缓存太久。 */
  async function meta(fsId: number, options: DownloadOptions = {}): Promise<DownloadMeta> {
    const result = await withRetry(() => api.fileMetas({ fsids: [fsId], dlink: 1 }), options.retry);
    const first = (result.list ?? [])[0];
    if (first === undefined) {
      throw new DownloadError('没有查到这个 fsid 的文件', fsId);
    }
    // 单条查询失败时顶层 errno 仍是 0，失败信息在这条记录上
    if (first.errno !== undefined && first.errno !== 0) {
      throw new DownloadError('查询文件信息失败 errno ' + first.errno, fsId);
    }
    return toMeta(first, fsId);
  }

  async function downloadUrl(fsId: number, options?: DownloadOptions): Promise<string> {
    return (await meta(fsId, options)).dlink;
  }

  /**
   * 把 dlink 换成同源地址。
   * dlink 的响应没有 Access-Control-Allow-Origin，fetch 直连会被浏览器拦掉，
   * 只有经过同源代理这一跳才能把内容交给 JS。
   */
  function sameOriginUrl(dlink: string): string {
    const marker = '//' + DLINK_HOST;
    const at = dlink.indexOf(marker);
    if (at < 0) return dlink;
    return proxyPrefix + dlink.slice(at + marker.length);
  }

  async function fetchBlob(fsId: number, options: DownloadOptions = {}): Promise<Blob> {
    const info = await meta(fsId, options);
    const response = await fetch(sameOriginUrl(info.dlink), { signal: options.signal });
    if (!response.ok) {
      throw new DownloadError('下载失败 HTTP ' + response.status, fsId);
    }
    return response.blob();
  }

  /**
   * 触发浏览器下载。走导航而不是 fetch，所以不需要代理、也不受 CORS 限制。
   * 注意 download 属性对跨域地址无效，文件名由服务端决定，传 filename 也改不了。
   */
  async function saveAs(fsId: number, filename?: string, options?: DownloadOptions): Promise<void> {
    if (typeof document === 'undefined') {
      throw new DownloadError('saveAs 需要 DOM；Node 环境请用 fetchBlob 自己落盘', fsId);
    }
    const info = await meta(fsId, options);
    const anchor = document.createElement('a');
    anchor.href = info.dlink;
    anchor.download = filename ?? info.filename;
    anchor.rel = 'noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  return { meta, downloadUrl, sameOriginUrl, fetchBlob, saveAs };
}
