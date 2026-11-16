// 上传场景。只做编排，端点描述在 baidu-drive-sdk-js/api。
//
// 相对直接调端点，这一层多做五件事：
// 1. 按文件大小自动选路：小文件走单步上传（省两次往返、不用算 MD5），大文件走三步
// 2. 三步流程的串联：precreate → 逐片 superfile2 → create，并处理秒传提前结束
// 3. 分片 MD5 计算（浏览器 crypto.subtle 没有 MD5，用 spark-md5）
// 4. create 用的是**云端返回**的分片 MD5，不是本地算的那份
// 5. 进度回调，按已上传字节数算
//
// 上传域名侧（superfile2 / 单步上传）和 pan.baidu.com 是两个 base，
// 所以要两个 OpenApi 实例，由 app 装配。

import {
  PRECREATE,
  SINGLE_UPLOAD,
  SUPERFILE2,
  UPLOAD_CREATE,
  apiErrno,
  withRetry
} from '../../api';
import type {
  OpenApi,
  PrecreateParams,
  PrecreateResult,
  RetryOptions,
  SingleUploadParams,
  SingleUploadResult,
  Superfile2Params,
  Superfile2Result,
  UploadCreateParams,
  UploadCreateResult
} from '../../api';
import SparkMD5 from 'spark-md5';

/** 平台规定的分片大小，改小会导致 block_list 和实际分片对不上 */
export const SLICE_SIZE = 4 * 1024 * 1024;

/** 不超过一个分片就走单步上传 */
export const SINGLE_UPLOAD_MAX = SLICE_SIZE;

/** 文件级上限取决于会员等级：普通 4GB、会员 10GB、超级会员 20GB */
export const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024;

export type OnDupPolicy = 'fail' | 'overwrite' | 'newcopy';

export interface UploadProgress {
  /** 已上传字节数 */
  loaded: number;
  total: number;
  /** 0~1 */
  ratio: number;
}

export interface UploadOptions {
  /** 重名策略，默认 fail */
  ondup?: OnDupPolicy;
  /** 强制走三步流程，用于测试或需要秒传时 */
  forceSlice?: boolean;
  onProgress?: (progress: UploadProgress) => void;
  retry?: RetryOptions;
  signal?: AbortSignal;
}

export interface UploadResult {
  fsId: number;
  path: string;
  size: number;
  /** 走了哪条路，便于排查 */
  via: 'single' | 'slice' | 'rapid';
}

/** 上传失败。带上是哪个文件、哪一步、什么 errno。 */
export class UploadError extends Error {
  path: string;
  stage: 'precreate' | 'slice' | 'create' | 'single';
  errno?: number;

  constructor(message: string, path: string, stage: UploadError['stage'], errno?: number) {
    super(message);
    this.name = 'UploadError';
    this.path = path;
    this.stage = stage;
    this.errno = errno;
  }
}

/** 算一个 Blob 的 MD5（32 位小写）。浏览器的 crypto.subtle 不支持 MD5，只能自己算。 */
export async function md5OfBlob(blob: Blob): Promise<string> {
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(await blob.arrayBuffer());
  return spark.end();
}

export function sliceFile(file: Blob, sliceSize = SLICE_SIZE): Blob[] {
  if (file.size === 0) return [file];
  const slices: Blob[] = [];
  for (let start = 0; start < file.size; start += sliceSize) {
    slices.push(file.slice(start, Math.min(start + sliceSize, file.size)));
  }
  return slices;
}

function missing(name: string) {
  return (): never => {
    throw new Error('createFileUpload 缺少端点实现：' + name);
  };
}

/** pan.baidu.com 侧的端点 */
export interface MetaDeps {
  precreate: (params?: PrecreateParams) => Promise<PrecreateResult>;
  uploadCreate: (params?: UploadCreateParams) => Promise<UploadCreateResult>;
}

/** 上传域名侧的端点，base 和上面那组不同 */
export interface TransferDeps {
  superfile2: (
    params?: Superfile2Params,
    options?: { multipart?: Record<string, string | Blob>; signal?: AbortSignal }
  ) => Promise<Superfile2Result>;
  singleUpload: (
    params?: SingleUploadParams,
    options?: { multipart?: Record<string, string | Blob>; signal?: AbortSignal }
  ) => Promise<SingleUploadResult>;
}

export interface FileUploadConfig {
  /** pan.baidu.com 的实例，用 '/pan' 之类的同源前缀 */
  api: OpenApi | Partial<MetaDeps>;
  /** 上传域名的实例，用 '/pcs' 之类的同源前缀 */
  upload: OpenApi | Partial<TransferDeps>;
  /** 覆盖 MD5 实现，默认 spark-md5 */
  computeMd5?: (blob: Blob) => Promise<string>;
  /** 覆盖分片大小，只在平台改规则时才动 */
  sliceSize?: number;
}

export interface FileUpload {
  upload: (file: Blob, path: string, options?: UploadOptions) => Promise<UploadResult>;
}

export function createFileUpload(config: FileUploadConfig): FileUpload {
  const meta: MetaDeps =
    'defineApi' in config.api
      ? {
          precreate: config.api.defineApi(PRECREATE),
          uploadCreate: config.api.defineApi(UPLOAD_CREATE)
        }
      : {
          precreate: config.api.precreate ?? missing('precreate'),
          uploadCreate: config.api.uploadCreate ?? missing('uploadCreate')
        };

  const transfer: TransferDeps =
    'defineApi' in config.upload
      ? {
          superfile2: config.upload.defineApi(SUPERFILE2),
          singleUpload: config.upload.defineApi(SINGLE_UPLOAD)
        }
      : {
          superfile2: config.upload.superfile2 ?? missing('superfile2'),
          singleUpload: config.upload.singleUpload ?? missing('singleUpload')
        };

  const computeMd5 = config.computeMd5 ?? md5OfBlob;
  const sliceSize = config.sliceSize ?? SLICE_SIZE;

  function report(options: UploadOptions, loaded: number, total: number): void {
    options.onProgress?.({ loaded, total, ratio: total > 0 ? loaded / total : 1 });
  }

  // 上传链路的失败大多是非 2xx（400 重名、403 越权），业务码藏在 HttpError.body 里，
  // 直接读 error.errno 会是 undefined，必须走 apiErrno。
  function fail(error: unknown, path: string, stage: UploadError['stage']): never {
    const errno = apiErrno(error);
    const message = (error as { message?: string }).message ?? '上传失败';
    throw new UploadError(message, path, stage, errno === 0 ? undefined : errno);
  }

  // ondup 在三步流程里要翻成 rtype：接口两套命名表达同一件事
  function rtypeOf(ondup: OnDupPolicy | undefined): 0 | 1 | 3 {
    if (ondup === 'overwrite') return 3;
    if (ondup === 'newcopy') return 1;
    return 0;
  }

  /** 重试要跟着调用方的取消信号一起走，否则取消后还会把剩下的重试发完。 */
  function retryOf(options: UploadOptions): RetryOptions {
    return { ...options.retry, signal: options.signal };
  }

  function throwIfAborted(path: string, options: UploadOptions): void {
    if (options.signal?.aborted) throw new UploadError('上传已取消', path, 'precreate');
  }

  /** 单步上传：一次请求搞定，不算 MD5。小文件走这条。 */
  async function uploadSingle(
    file: Blob,
    path: string,
    options: UploadOptions
  ): Promise<UploadResult> {
    report(options, 0, file.size);
    const result = await withRetry(
      () =>
        transfer.singleUpload(
          { path, ondup: options.ondup ?? 'fail' },
          { multipart: { file }, signal: options.signal }
        ),
      retryOf(options)
    ).catch((error: unknown) => fail(error, path, 'single'));
    report(options, file.size, file.size);
    return { fsId: result.fs_id, path: result.path, size: result.size, via: 'single' };
  }

  /** 三步上传：precreate → 逐片 superfile2 → create。 */
  async function uploadSliced(
    file: Blob,
    path: string,
    options: UploadOptions
  ): Promise<UploadResult> {
    const slices = sliceFile(file, sliceSize);
    // 串行逐片算：Promise.all 会同时持有全部分片的 ArrayBuffer，内存峰值≈文件大小，
    // 20GB 上限下必然把标签页撑爆。串行时同一时刻只占一片（几 MB）。
    const localMd5s: string[] = [];
    for (const slice of slices) {
      throwIfAborted(path, options);
      localMd5s.push(await computeMd5(slice));
    }
    report(options, 0, file.size);

    const pre = await withRetry(
      () =>
        meta.precreate({
          path,
          size: file.size,
          isdir: 0,
          autoinit: 1,
          block_list: localMd5s,
          rtype: rtypeOf(options.ondup)
        }),
      retryOf(options)
    ).catch((error: unknown) => fail(error, path, 'precreate'));

    // 秒传命中：云端已有这份内容，后两步都不用做
    if (pre.return_type === 2) {
      report(options, file.size, file.size);
      return { fsId: 0, path, size: file.size, via: 'rapid' };
    }

    // precreate 会告诉我们哪些分片还缺；断点续传时不是全部。
    // 平台文档：block_list 为空数组等价于 [0]（只传第一片），不能当成「没有分片要传」。
    const pending =
      pre.block_list === undefined
        ? slices.map((_, index) => index)
        : pre.block_list.length > 0
          ? pre.block_list
          : [0];
    // create 要的是云端 MD5。先用本地值占位，上传过的分片再覆盖成云端返回值。
    const remoteMd5s = [...localMd5s];
    let loaded = 0;

    for (const index of pending) {
      const slice = slices[index];
      if (slice === undefined) {
        throw new UploadError('precreate 要求上传不存在的分片 ' + index, path, 'slice');
      }
      throwIfAborted(path, options);
      const uploaded = await withRetry(
        () =>
          transfer.superfile2(
            { path, uploadid: pre.uploadid, partseq: index },
            { multipart: { file: slice }, signal: options.signal }
          ),
        retryOf(options)
      ).catch((error: unknown) => fail(error, path, 'slice'));
      if (uploaded.md5) remoteMd5s[index] = uploaded.md5;
      loaded += slice.size;
      report(options, loaded, file.size);
    }

    const created = await withRetry(
      () =>
        meta.uploadCreate({
          path,
          size: file.size,
          isdir: 0,
          uploadid: pre.uploadid,
          block_list: remoteMd5s,
          rtype: rtypeOf(options.ondup)
        }),
      retryOf(options)
    ).catch((error: unknown) => fail(error, path, 'create'));

    report(options, file.size, file.size);
    return { fsId: created.fs_id, path: created.path, size: created.size, via: 'slice' };
  }

  /**
   * 上传一个文件。不超过 4MB 默认走单步上传，超过走三步分片。
   * 需要秒传或断点续传时传 forceSlice，让它走三步流程。
   */
  async function upload(
    file: Blob,
    path: string,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    if (file.size > MAX_FILE_SIZE) {
      throw new UploadError('文件超过平台上限 ' + MAX_FILE_SIZE + ' 字节', path, 'precreate');
    }
    const single = !options.forceSlice && file.size <= SINGLE_UPLOAD_MAX;
    return single ? uploadSingle(file, path, options) : uploadSliced(file, path, options);
  }

  return { upload };
}
