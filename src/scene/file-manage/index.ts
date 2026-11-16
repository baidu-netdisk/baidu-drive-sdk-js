// 文件管理场景。只做编排，端点描述在 baidu-drive-sdk-js/api。
//
// 相对直接调端点，这一层多做四件事：
// 1. 操作前检查源文件存在、目标不冲突，避免发出必然失败的请求
// 2. 把 info[].errno 的逐条失败翻译成异常 —— 顶层 errno 为 0 时它仍可能失败
// 3. mkdirIfNotExist 幂等：已存在就跳过，不报错
// 4. errno 111（有其他异步任务执行中）走重试

import {
  COPY_FILES,
  CREATE_FOLDER,
  DELETE_FILES,
  FILE_META,
  LIST_FILES,
  MOVE_FILES,
  RENAME_FILES,
  apiErrno,
  withRetry
} from '../../api';
import type {
  CreateFolderParams,
  CreateFolderResult,
  FileManagerParams,
  FileManagerResult,
  FileMetaParams,
  FileMetasResult,
  ListFilesParams,
  ListFilesResult,
  OnDup,
  OpenApi,
  RetryOptions
} from '../../api';

export interface ManageOptions {
  /** 重复文件处理策略，默认 fail */
  ondup?: OnDup;
  /** 0 同步、1 自适应、2 异步，默认 1 */
  async?: 0 | 1 | 2;
  /** 关掉操作前的存在性检查，省一次请求 */
  skipPrecheck?: boolean;
  retry?: RetryOptions;
}

/** 单条操作失败。顶层 errno 可能是 0，失败信息在 info[] 里。 */
export class FileOperationError extends Error {
  path: string;
  errno: number;

  constructor(message: string, path: string, errno: number) {
    super(message);
    this.name = 'FileOperationError';
    this.path = path;
    this.errno = errno;
  }
}

export interface FileManageDeps {
  fileMeta: (params?: FileMetaParams) => Promise<FileMetasResult>;
  /**
   * 列目录。用来判断「目录是否存在」——meta 只能查文件，查目录会返回 400/31301，
   * 在浏览器网络面板里是一条无意义的红字。可选：没提供时退回 meta 探测。
   */
  listFiles?: (params?: ListFilesParams) => Promise<ListFilesResult>;
  copyFiles: (params?: FileManagerParams) => Promise<FileManagerResult>;
  moveFiles: (params?: FileManagerParams) => Promise<FileManagerResult>;
  renameFiles: (params?: FileManagerParams) => Promise<FileManagerResult>;
  deleteFiles: (params?: FileManagerParams) => Promise<FileManagerResult>;
  createFolder: (params?: CreateFolderParams) => Promise<CreateFolderResult>;
}

export interface FileManage {
  exists: (path: string) => Promise<boolean>;
  copy: (from: string, toDir: string, newName?: string, options?: ManageOptions) => Promise<void>;
  move: (from: string, toDir: string, newName?: string, options?: ManageOptions) => Promise<void>;
  rename: (path: string, newName: string, options?: ManageOptions) => Promise<void>;
  remove: (paths: string[], options?: ManageOptions) => Promise<void>;
  mkdirIfNotExist: (path: string, options?: ManageOptions) => Promise<void>;
}

function missing(name: string) {
  return (): never => {
    throw new Error('createFileManage 缺少端点实现：' + name);
  };
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// 顶层 errno 已由 baidu-drive-sdk-js/api 判过；这里只管逐条结果
function assertEachOk(result: FileManagerResult): void {
  const failed = (result.info ?? []).find((item) => item.errno !== 0);
  if (failed) {
    throw new FileOperationError('文件操作失败 errno ' + failed.errno, failed.path, failed.errno);
  }
}

// 「路径不存在」有两种表达：errno -9，以及 HTTP 404 + error_code 31066。
// 实测 method=meta 走的是后者，只认 -9 的话 exists 会直接抛错而不是返回 false。
const NOT_FOUND_ERRNOS = new Set([-9, 31066]);

// meta 只接受「stream file」：查目录实测返回 HTTP 400 + error_code 31301（not stream file）。
// 语义是「路径存在，但不是文件」，所以 exists() 要返回 true —— 否则 mkdirIfNotExist
// 在目录已存在时会抛错，浏览器侧表现成「建目录 400」。
const PATH_IS_DIRECTORY_ERRNOS = new Set([31301]);

export function createFileManage(source: OpenApi | Partial<FileManageDeps>): FileManage {
  const api: FileManageDeps =
    'defineApi' in source
      ? {
          fileMeta: source.defineApi(FILE_META),
          listFiles: source.defineApi(LIST_FILES),
          copyFiles: source.defineApi(COPY_FILES),
          moveFiles: source.defineApi(MOVE_FILES),
          renameFiles: source.defineApi(RENAME_FILES),
          deleteFiles: source.defineApi(DELETE_FILES),
          createFolder: source.defineApi(CREATE_FOLDER)
        }
      : {
          fileMeta: source.fileMeta ?? missing('fileMeta'),
          listFiles: source.listFiles,
          copyFiles: source.copyFiles ?? missing('copyFiles'),
          moveFiles: source.moveFiles ?? missing('moveFiles'),
          renameFiles: source.renameFiles ?? missing('renameFiles'),
          deleteFiles: source.deleteFiles ?? missing('deleteFiles'),
          createFolder: source.createFolder ?? missing('createFolder')
        };

  /** 按路径判断存在性。「不存在」是预期分支，不是异常；越权（20020）这类错误仍然抛出。 */
  async function exists(path: string): Promise<boolean> {
    try {
      const result = await api.fileMeta({ path });
      return (result.list ?? []).length > 0;
    } catch (error) {
      const errno = apiErrno(error);
      if (NOT_FOUND_ERRNOS.has(errno)) return false;
      if (PATH_IS_DIRECTORY_ERRNOS.has(errno)) return true;
      throw error;
    }
  }

  // 前置检查只负责拦「确定会失败」的请求，查不动就放行：
  // 实测应用 token 查应用目录外的路径会报 20020，但 filemanager 确实能 copy 这些文件，
  // 在这里拦下来等于把平台允许的操作误判成失败。
  async function requireExists(path: string, skip?: boolean): Promise<void> {
    if (skip) return;
    let present: boolean;
    try {
      present = await exists(path);
    } catch {
      return;
    }
    if (!present) {
      throw new FileOperationError('源文件不存在：' + path, path, -9);
    }
  }

  async function runManager(
    call: (params: FileManagerParams) => Promise<FileManagerResult>,
    filelist: unknown[],
    options: ManageOptions
  ): Promise<void> {
    const result = await withRetry(
      () =>
        call({
          async: options.async ?? 1,
          filelist,
          ondup: options.ondup
        }),
      options.retry
    );
    assertEachOk(result);
  }

  async function copy(
    from: string,
    toDir: string,
    newName = basename(from),
    options: ManageOptions = {}
  ) {
    await requireExists(from, options.skipPrecheck);
    await runManager(api.copyFiles, [{ path: from, dest: toDir, newname: newName }], options);
  }

  async function move(
    from: string,
    toDir: string,
    newName = basename(from),
    options: ManageOptions = {}
  ) {
    await requireExists(from, options.skipPrecheck);
    await runManager(api.moveFiles, [{ path: from, dest: toDir, newname: newName }], options);
  }

  async function rename(path: string, newName: string, options: ManageOptions = {}) {
    await requireExists(path, options.skipPrecheck);
    await runManager(api.renameFiles, [{ path, newname: newName }], options);
  }

  /** 删除。filelist 是路径字符串数组，不是对象数组。 */
  async function remove(paths: string[], options: ManageOptions = {}) {
    if (paths.length === 0) return;
    await runManager(api.deleteFiles, paths, options);
  }

  /**
   * 目录是否存在。
   * 能用 list 就用 list：meta 只接受 stream file，查目录固定返回 HTTP 400 + 31301，
   * 虽然 catch 得住，但会在浏览器网络面板里留下一条误导性的 400。
   */
  async function dirExists(path: string): Promise<boolean> {
    if (api.listFiles !== undefined) {
      try {
        await api.listFiles({ dir: path, start: 0, limit: 1 });
        return true;
      } catch (error) {
        const errno = apiErrno(error);
        if (NOT_FOUND_ERRNOS.has(errno)) return false;
        // 越权必须抛；其它错误（限流、网络）退回 meta 再判一次更稳妥
        if (errno === 20020) throw error;
      }
    }
    return exists(path);
  }

  /** 幂等建目录：已存在就什么都不做。 */
  async function mkdirIfNotExist(path: string, options: ManageOptions = {}) {
    if (!options.skipPrecheck && (await dirExists(path))) return;
    await withRetry(() => api.createFolder({ path, isdir: 1 }), options.retry);
  }

  return { exists, copy, move, rename, remove, mkdirIfNotExist };
}
