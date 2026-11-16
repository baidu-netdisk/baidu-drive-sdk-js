// 文件浏览与搜索场景。只做编排，端点描述在 baidu-drive-sdk-js/api。
//
// 相对直接调端点，这一层多做四件事：
// 1. listDir 自动补 start —— 实测 limit 单独传会被忽略，必须配 start 才生效
// 2. listAll 自动翻页，突破单次 1000 条上限
// 3. 文件名和路径统一解码 —— 接口返回的是 URL 编码的，直接渲染会是一串 %E5
// 4. 瞬时错误（网络抖动、31034 频率超限）自动重试

import {
  BT_LIST,
  CATEGORY_INFO,
  CATEGORY_LIST,
  DOC_LIST,
  IMAGE_LIST,
  LIST_ALL,
  LIST_FILES,
  SEARCH_FILES,
  UNISEARCH,
  VIDEO_LIST,
  withRetry
} from '../../api';
import type {
  CategoryInfoParams,
  CategoryInfoResult,
  CategoryListParams,
  CategoryListResult,
  FileCategory,
  ListAllParams,
  ListAllResult,
  ListFilesParams,
  ListFilesResult,
  MediaListParams,
  MediaListResult,
  OpenApi,
  PanFile,
  RetryOptions,
  SearchFilesParams,
  SearchFilesResult,
  UniSearchParams,
  UniSearchResult
} from '../../api';

export interface BrowseFile extends PanFile {
  /** 解码后的文件名，渲染用这个 */
  name: string;
  /** 解码后的绝对路径 */
  decodedPath: string;
}

export interface ListDirOptions {
  order?: 'time' | 'name' | 'size';
  desc?: boolean;
  start?: number;
  limit?: number;
  /** 只要文件夹 */
  onlyFolder?: boolean;
  /** 翻页上限，默认 50；超过会抛 BrowseTruncatedError，不要靠它静默截断 */
  maxPages?: number;
  retry?: RetryOptions;
}

export interface SearchOptions {
  dir?: string;
  /** 1 视频 2 音频 3 图片 4 文档 5 应用 6 其他 7 种子 */
  category?: number;
  /** 默认递归搜索整个目录树 */
  recursive?: boolean;
  retry?: RetryOptions;
}

export interface SearchResult {
  files: BrowseFile[];
  hasMore: boolean;
}

/** 递归列目录树的选项。和 listDir 的分页模型不同，这里靠 cursor 翻页。 */
export interface ListTreeOptions {
  /** 默认 true，递归整棵子树 */
  recursive?: boolean;
  order?: 'time' | 'name' | 'size';
  desc?: boolean;
  /** 单次上限 10000，默认 1000 */
  limit?: number;
  /** 只要创建时间晚于这个时间戳的 */
  createdAfter?: number;
  /** 只要修改时间晚于这个时间戳的 */
  modifiedAfter?: number;
  /** 翻页上限，默认 50；超过会抛 BrowseTruncatedError */
  maxPages?: number;
  retry?: RetryOptions;
}

export interface CategoryOptions {
  parentPath?: string;
  /** 默认 true */
  recursive?: boolean;
  /** 扩展名过滤，如 ['mp3', 'flac'] */
  extensions?: string[];
  showDir?: boolean;
  start?: number;
  limit?: number;
  order?: 'time' | 'name' | 'size';
  desc?: boolean;
  retry?: RetryOptions;
}

export interface MediaOptions {
  parentPath?: string;
  /** 默认 true */
  recursive?: boolean;
  /** 不传则不分页，一次拿全部 */
  page?: number;
  num?: number;
  order?: 'time' | 'name' | 'size';
  desc?: boolean;
  retry?: RetryOptions;
}

export interface SemanticSearchOptions {
  /** 搜索目录，默认 ['/'] */
  dirs?: string[];
  categories?: FileCategory[];
  num?: number;
  /** 默认 2（自动：5 字以上走语义） */
  searchType?: 0 | 1 | 2;
  retry?: RetryOptions;
}

export interface CategoryStat {
  category: FileCategory;
  count: number;
  size: number;
}

// 接口返回的 server_filename / path 是 URL 编码的，解码失败时退回原值，
// 不能让一个坏名字把整次列目录搞崩。
function decode(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// folder=1（只看文件夹）时平台只返回 path、不返回 server_filename，
// 直接用 server_filename 会得到字符串 "undefined"；退回路径最后一段。
export function toBrowseFile(file: PanFile): BrowseFile {
  const decodedPath = decode(file.path);
  const name = decode(file.server_filename) || basename(decodedPath);
  return { ...file, name, decodedPath };
}

/** 翻页到达上限但目录还没取完时抛出，避免把「截断」伪装成「取全了」。 */
export class BrowseTruncatedError extends Error {
  dir: string;
  pages: number;
  count: number;

  constructor(message: string, dir: string, pages: number, count: number) {
    super(message);
    this.name = 'BrowseTruncatedError';
    this.dir = dir;
    this.pages = pages;
    this.count = count;
  }
}

// 返回一个「被调用才抛」的函数：单测只传了部分假端点、却调到没传的那个时暴露疏漏。
// 注意不能在这里直接抛，否则构造实例的那一刻就炸了。
function missing(name: string) {
  return (): never => {
    throw new Error('createFileBrowse 缺少端点实现：' + name);
  };
}

const MAX_PAGES = 50;
/** 平台单页上限：limit 传超过这个值会被截断，拿它当「短页即结束」的判断会误判 */
const PLATFORM_PAGE_MAX = 1000;
/** listall 的 limit 上限 */
const LIST_ALL_PAGE_MAX = 10000;

// 端点由传进来的 OpenApi 实例绑定——哪个 app、哪个账号的 token，由实例决定。
// 没有默认实例，所以不存在「忘了装配」或「多账号互相覆盖」。
export interface FileBrowseDeps {
  listFiles: (params?: ListFilesParams) => Promise<ListFilesResult>;
  searchFiles: (params?: SearchFilesParams) => Promise<SearchFilesResult>;
  listAllFiles: (params?: ListAllParams) => Promise<ListAllResult>;
  categoryList: (params?: CategoryListParams) => Promise<CategoryListResult>;
  categoryInfo: (params?: CategoryInfoParams) => Promise<CategoryInfoResult>;
  imageList: (params?: MediaListParams) => Promise<MediaListResult>;
  videoList: (params?: MediaListParams) => Promise<MediaListResult>;
  docList: (params?: MediaListParams) => Promise<MediaListResult>;
  btList: (params?: MediaListParams) => Promise<MediaListResult>;
  uniSearch: (params?: UniSearchParams, options?: { json?: unknown }) => Promise<UniSearchResult>;
}

export interface FileBrowse {
  listDir: (dir: string, options?: ListDirOptions) => Promise<BrowseFile[]>;
  listAll: (dir: string, options?: ListDirOptions) => Promise<BrowseFile[]>;
  /** 递归列整棵子树，走平台的 listall 接口 */
  listTree: (dir: string, options?: ListTreeOptions) => Promise<BrowseFile[]>;
  search: (keyword: string, options?: SearchOptions) => Promise<SearchResult>;
  /** 自然语言搜索，走 unisearch */
  searchSemantic: (query: string, options?: SemanticSearchOptions) => Promise<BrowseFile[]>;
  byCategory: (
    category: FileCategory | FileCategory[],
    options?: CategoryOptions
  ) => Promise<SearchResult>;
  categoryStats: (
    category: FileCategory | FileCategory[],
    options?: Pick<CategoryOptions, 'parentPath' | 'recursive' | 'retry'>
  ) => Promise<CategoryStat[]>;
  images: (options?: MediaOptions) => Promise<BrowseFile[]>;
  videos: (options?: MediaOptions) => Promise<BrowseFile[]>;
  docs: (options?: MediaOptions) => Promise<BrowseFile[]>;
  torrents: (options?: MediaOptions) => Promise<BrowseFile[]>;
}

/**
 * @param source 通常传 createOpenApi() 的实例；单测里可以只传用到的那几个假端点
 */
export function createFileBrowse(source: OpenApi | Partial<FileBrowseDeps>): FileBrowse {
  const api: FileBrowseDeps =
    'defineApi' in source
      ? {
          listFiles: source.defineApi(LIST_FILES),
          searchFiles: source.defineApi(SEARCH_FILES),
          listAllFiles: source.defineApi(LIST_ALL),
          categoryList: source.defineApi(CATEGORY_LIST),
          categoryInfo: source.defineApi(CATEGORY_INFO),
          imageList: source.defineApi(IMAGE_LIST),
          videoList: source.defineApi(VIDEO_LIST),
          docList: source.defineApi(DOC_LIST),
          btList: source.defineApi(BT_LIST),
          uniSearch: source.defineApi(UNISEARCH)
        }
      : {
          listFiles: source.listFiles ?? missing('listFiles'),
          searchFiles: source.searchFiles ?? missing('searchFiles'),
          listAllFiles: source.listAllFiles ?? missing('listAllFiles'),
          categoryList: source.categoryList ?? missing('categoryList'),
          categoryInfo: source.categoryInfo ?? missing('categoryInfo'),
          imageList: source.imageList ?? missing('imageList'),
          videoList: source.videoList ?? missing('videoList'),
          docList: source.docList ?? missing('docList'),
          btList: source.btList ?? missing('btList'),
          uniSearch: source.uniSearch ?? missing('uniSearch')
        };

  /** 列目录。limit 会自动配上 start，不必自己记这个坑。 */
  async function listDir(dir: string, options: ListDirOptions = {}): Promise<BrowseFile[]> {
    const result = await withRetry(
      () =>
        api.listFiles({
          dir,
          order: options.order,
          desc: options.desc === undefined ? undefined : options.desc ? 1 : 0,
          start: options.start ?? 0,
          limit: options.limit,
          folder: options.onlyFolder ? 1 : undefined
        }),
      options.retry
    );
    return result.list.map(toBrowseFile);
  }

  /**
   * 列出目录下全部条目，自动翻页。
   * 单次接口上限 1000 条，超过的目录必须翻页才拿得全。
   * 最多翻 MAX_PAGES 页兜底，避免目录异常时无限循环。
   */
  async function listAll(dir: string, options: ListDirOptions = {}): Promise<BrowseFile[]> {
    // 页大小必须夹到平台上限：传 2000 会被平台截成 1000，
    // 而「返回条数 < 页大小」是结束条件，不夹就会把第一页当成最后一页。
    const pageSize = Math.min(options.limit ?? PLATFORM_PAGE_MAX, PLATFORM_PAGE_MAX);
    const maxPages = options.maxPages ?? MAX_PAGES;
    const all: BrowseFile[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await listDir(dir, { ...options, start: page * pageSize, limit: pageSize });
      all.push(...batch);
      if (batch.length < pageSize) return all;
    }
    throw new BrowseTruncatedError(
      '目录 ' +
        dir +
        ' 超过 ' +
        maxPages +
        ' 页（' +
        pageSize +
        ' 条/页），已停止翻页；' +
        '目录确实这么大时用 options.maxPages 放宽，或改用 listTree',
      dir,
      maxPages,
      all.length
    );
  }

  /** 按关键字搜索。默认递归整个目录树，这是大多数场景想要的行为。 */
  async function search(keyword: string, options: SearchOptions = {}): Promise<SearchResult> {
    const result = await withRetry(
      () =>
        api.searchFiles({
          key: keyword,
          dir: options.dir,
          category: options.category,
          recursion: options.recursive === false ? undefined : 1
        }),
      options.retry
    );
    return { files: result.list.map(toBrowseFile), hasMore: result.has_more === 1 };
  }

  /**
   * 递归列出整棵子树，走平台的 listall 接口。
   * 和 listAll 不是一回事：listAll 是「把一个目录翻页翻完」，
   * listTree 是「连子目录一起列出来」。名字相近，别用错。
   * 这个接口的翻页靠返回的 cursor，不是自己累加 start。
   */
  async function listTree(dir: string, options: ListTreeOptions = {}): Promise<BrowseFile[]> {
    const limit = Math.min(options.limit ?? PLATFORM_PAGE_MAX, LIST_ALL_PAGE_MAX);
    const maxPages = options.maxPages ?? MAX_PAGES;
    const all: BrowseFile[] = [];
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await withRetry(
        () =>
          api.listAllFiles({
            path: dir,
            recursion: options.recursive === false ? 0 : 1,
            order: options.order,
            desc: options.desc === undefined ? undefined : options.desc ? 1 : 0,
            start,
            limit,
            ctime: options.createdAfter,
            mtime: options.modifiedAfter
          }),
        options.retry
      );
      all.push(...(result.list ?? []).map(toBrowseFile));
      if (result.has_more !== 1) return all;
      // cursor 缺失时只能停下，继续用旧 start 会无限拉同一页
      if (result.cursor === undefined) return all;
      start = result.cursor;
    }
    throw new BrowseTruncatedError(
      '目录 ' +
        dir +
        ' 的子树超过 ' +
        maxPages +
        ' 页，已停止翻页；' +
        '目录确实这么大时用 options.maxPages 放宽',
      dir,
      maxPages,
      all.length
    );
  }

  /** 按分类取文件。分类号：1 视频 2 音频 3 图片 4 文档 5 应用 6 其他 7 种子 */
  async function byCategory(
    category: FileCategory | FileCategory[],
    options: CategoryOptions = {}
  ): Promise<SearchResult> {
    const result = await withRetry(
      () =>
        api.categoryList({
          category: categoryParam(category),
          parent_path: options.parentPath,
          recursion: options.recursive === false ? 0 : 1,
          ext: options.extensions?.join(','),
          show_dir: options.showDir ? 1 : undefined,
          start: options.start,
          limit: options.limit,
          order: options.order,
          desc: options.desc === undefined ? undefined : options.desc ? 1 : 0
        }),
      options.retry
    );
    return { files: (result.list ?? []).map(toBrowseFile), hasMore: result.has_more === 1 };
  }

  /** 分类下的文件数和占用空间。做「图片 1.2 万张 / 共 30 GB」这类统计用。 */
  async function categoryStats(
    category: FileCategory | FileCategory[],
    options: Pick<CategoryOptions, 'parentPath' | 'recursive' | 'retry'> = {}
  ): Promise<CategoryStat[]> {
    const result = await withRetry(
      () =>
        api.categoryInfo({
          category: categoryParam(category),
          parent_path: options.parentPath,
          recursion: options.recursive === false ? 0 : 1
        }),
      options.retry
    );
    return Object.entries(result.info ?? {}).map(([key, value]) => ({
      category: Number(key) as FileCategory,
      count: value.count,
      size: value.size
    }));
  }

  // imagelist / videolist / doclist / btlist 这一族：
  // 用 page / num 分页（不是 start / limit），结果在 info 字段（不是 list）
  function mediaFetcher(call: (params?: MediaListParams) => Promise<MediaListResult>) {
    return async (options: MediaOptions = {}): Promise<BrowseFile[]> => {
      const result = await withRetry(
        () =>
          call({
            parent_path: options.parentPath,
            page: options.page,
            num: options.num,
            order: options.order,
            desc: options.desc === undefined ? undefined : options.desc ? 1 : 0,
            recursion: options.recursive === false ? 0 : 1
          }),
        options.retry
      );
      return (result.info ?? []).map(toBrowseFile);
    };
  }

  const images = mediaFetcher(api.imageList);
  const videos = mediaFetcher(api.videoList);
  const docs = mediaFetcher(api.docList);
  const torrents = mediaFetcher(api.btList);

  /**
   * 自然语言搜索。"找去年的合同"这类描述性查询用这个，不要用 search。
   * 参数全在查询串里，请求体固定是 {}。
   */
  async function searchSemantic(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<BrowseFile[]> {
    const result = await withRetry(
      () =>
        api.uniSearch(
          {
            scene: 'mcpserver',
            query,
            dir: options.dirs ?? ['/'],
            category: options.categories,
            num: options.num,
            search_type: options.searchType ?? 2
          },
          { json: {} }
        ),
      options.retry
    );
    return (result.list ?? []).map(toBrowseFile);
  }

  return {
    listDir,
    listAll,
    listTree,
    search,
    searchSemantic,
    byCategory,
    categoryStats,
    images,
    videos,
    docs,
    torrents
  };
}

function categoryParam(category: FileCategory | FileCategory[]): string {
  return (Array.isArray(category) ? category : [category]).join(',');
}
