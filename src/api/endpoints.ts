// 开放平台端点描述。纯数据，不绑任何 client，所以可被任意多个 app / 账号共用。
// 用法：某个 OpenApi 实例 defineApi(LIST_FILES) 之后才能调用。
//
// 新增端点就照抄接口文档的「请求结构 / 请求参数 / 响应参数」三张表，注释里留文档链接。

import { describeApi } from './openapi';

// 获取用户信息 https://pan.baidu.com/union/doc/基础网盘服务/获取用户信息/获取用户信息.md
export interface PanUserInfo {
  baidu_name: string;
  netdisk_name: string;
  avatar_url: string;
  vip_type: number;
  uk: number;
}

export const USER_INFO = describeApi<Record<string, never>, PanUserInfo>({
  path: '/rest/2.0/xpan/nas',
  fixedQuery: { method: 'uinfo' }
});

// 获取网盘容量信息 https://pan.baidu.com/union/doc/基础网盘服务/获取网盘容量信息.md
// 注意路径是 /api/quota，不在 /rest/2.0/xpan 下面，也没有 method 查询参数
// checkfree / checkexpire 默认都是 0，不传就拿不到 free 和 expire
export interface QuotaParams {
  checkfree?: 0 | 1;
  checkexpire?: 0 | 1;
}

export interface QuotaResult {
  errno: number;
  /** 总空间，单位字节 */
  total: number;
  /** 已用空间，单位字节 */
  used: number;
  /** 免费容量，不是剩余可用容量 */
  free?: number;
  /** 7 天内是否有容量到期 */
  expire?: boolean;
}

export const QUOTA = describeApi<QuotaParams, QuotaResult>({
  path: '/api/quota'
});

// 获取文件列表 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取文件列表.md
// 实测：limit 只在同时传 start 时生效，单独传 limit 会被忽略并返回 1000 条
export interface ListFilesParams {
  dir?: string;
  order?: 'time' | 'name' | 'size';
  desc?: 0 | 1;
  start?: number;
  limit?: number;
  folder?: 0 | 1;
  web?: 0 | 1;
}

export interface PanFile {
  fs_id: number;
  path: string;
  server_filename: string;
  size: number;
  isdir: 0 | 1;
  category: number;
  server_mtime: number;
}

export interface ListFilesResult {
  errno: number;
  guid_info: string;
  list: PanFile[];
}

export const LIST_FILES = describeApi<ListFilesParams, ListFilesResult>({
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'list' }
});

// 查询文件信息（fsids 批量） https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/查询文件信息.md
export interface FileMetasParams {
  fsids: number[];
  dlink?: 0 | 1;
  thumb?: 0 | 1;
  extra?: 0 | 1;
  needmedia?: 0 | 1;
  detail?: 0 | 1;
  path?: string;
}

export interface PanFileMeta {
  // 单个文件查询失败时这里是非 0，顶层 errno 仍然是 0，调用方要逐条判
  errno?: number;
  fs_id: number;
  path: string;
  filename: string;
  isdir: 0 | 1;
  size: number;
  category: number;
  md5?: string;
  dlink?: string;
}

export interface FileMetasResult {
  errno: number;
  list: PanFileMeta[];
}

export const FILE_METAS = describeApi<FileMetasParams, FileMetasResult>({
  path: '/rest/2.0/xpan/multimedia',
  fixedQuery: { method: 'filemetas' }
});

// 搜索文件 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/搜索文件（关键词搜索）.md
// 注意关键字的参数名是 key 不是 query；num 文档写明默认 500 且不可修改
export interface SearchFilesParams {
  key: string;
  dir?: string;
  category?: number;
  /** 传 1 递归搜索，不传则只搜当前目录 */
  recursion?: 1;
  web?: 0 | 1;
}

export interface SearchFilesResult {
  errno: number;
  has_more: number;
  list: PanFile[];
}

export const SEARCH_FILES = describeApi<SearchFilesParams, SearchFilesResult>({
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'search' }
});

// 查询单个文件信息（按路径） 同上文档的「单文件请求（method=meta）」
// 这是唯一能按路径判断存在性的端点，filemetas 只接受 fsid
// 实测路径不存在时返回 HTTP 404 + error_code 31066（不是 200 + errno），用 apiErrno 取码
// 实测路径不在应用授权范围内时返回 HTTP 200 + errno 20020
export interface FileMetaParams {
  path: string;
  dlink?: 0 | 1;
  thumb?: 0 | 1;
  extra?: 0 | 1;
}

export const FILE_META = describeApi<FileMetaParams, FileMetasResult>({
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'meta' }
});

// 管理文件 https://pan.baidu.com/union/doc/基础网盘服务/管理文件.md
// POST，opera 在查询串里，async / filelist / ondup 在表单体里。
// 顶层 errno 为 0 时逐条结果仍可能失败，必须看 info[].errno。
export type OnDup = 'fail' | 'newcopy' | 'overwrite' | 'skip';

export interface FileManagerParams {
  /** 0 同步、1 自适应、2 异步 */
  async: 0 | 1 | 2;
  /** JSON 数组，结构随 opera 变化；copy/move 为 {path,dest,newname}，rename 为 {path,newname}，delete 为路径字符串 */
  filelist: unknown[];
  ondup?: OnDup;
}

export interface FileManagerResult {
  errno: number;
  info?: Array<{ errno: number; path: string }>;
  taskid?: number;
}

function fileManager(opera: 'copy' | 'move' | 'rename' | 'delete') {
  return describeApi<FileManagerParams, FileManagerResult>({
    method: 'POST',
    path: '/rest/2.0/xpan/file',
    fixedQuery: { method: 'filemanager', opera }
  });
}

export const COPY_FILES = fileManager('copy');
export const MOVE_FILES = fileManager('move');
export const RENAME_FILES = fileManager('rename');
export const DELETE_FILES = fileManager('delete');

// 创建文件夹 https://pan.baidu.com/union/doc/基础网盘服务/创建文件夹.md
// isdir 固定为 1；rtype 0 冲突时失败、1 冲突时重命名
export interface CreateFolderParams {
  path: string;
  isdir: 1;
  rtype?: 0 | 1;
}

export interface CreateFolderResult {
  errno: number;
  fs_id?: number;
  path?: string;
  isdir?: number;
}

export const CREATE_FOLDER = describeApi<CreateFolderParams, CreateFolderResult>({
  method: 'POST',
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'create' }
});

// 递归获取文件列表 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/递归获取文件列表.md
// 和 LIST_FILES 的分页模型不一样：has_more 为 1 时要用返回的 cursor 当下一次的 start，
// 不是自己累加 offset。limit 上限 10000。
export interface ListAllParams {
  path: string;
  recursion?: 0 | 1;
  order?: 'time' | 'name' | 'size';
  desc?: 0 | 1;
  start?: number;
  limit?: number;
  /** 只返回创建时间大于该时间戳的文件 */
  ctime?: number;
  /** 只返回修改时间大于该时间戳的文件 */
  mtime?: number;
  web?: 0 | 1;
}

export interface ListAllResult {
  errno: number;
  list: PanFile[];
  has_more?: 0 | 1;
  /** 下一页的起点，has_more 为 1 时有效 */
  cursor?: number;
}

export const LIST_ALL = describeApi<ListAllParams, ListAllResult>({
  path: '/rest/2.0/xpan/multimedia',
  fixedQuery: { method: 'listall' }
});

// 文件分类。多个分类用英文逗号拼接。
export type FileCategory = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// 获取分类文件列表 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取分类文件列表.md
export interface CategoryListParams {
  /** 1 视频 2 音频 3 图片 4 文档 5 应用 6 其他 7 种子，多个用逗号分隔 */
  category: string;
  show_dir?: 0 | 1;
  parent_path?: string;
  recursion?: 0 | 1;
  /** 扩展名，多个用逗号分隔 */
  ext?: string;
  start?: number;
  limit?: number;
  order?: 'time' | 'name' | 'size';
  desc?: 0 | 1;
}

export interface CategoryListResult {
  errno: number;
  list: PanFile[];
  has_more?: 0 | 1;
  cursor?: number;
}

export const CATEGORY_LIST = describeApi<CategoryListParams, CategoryListResult>({
  path: '/rest/2.0/xpan/multimedia',
  fixedQuery: { method: 'categorylist' }
});

// 获取分类文件总个数 https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取分类文件总个数.md
// 路径是 /api/categoryinfo，和 QUOTA 一样不在 /rest/2.0/xpan 下
export interface CategoryInfoParams {
  category: string;
  parent_path?: string;
  recursion?: 0 | 1;
}

export interface CategoryInfoResult {
  errno: number;
  /** key 是分类号的字符串形式 */
  info: Record<string, { count: number; size: number }>;
}

export const CATEGORY_INFO = describeApi<CategoryInfoParams, CategoryInfoResult>({
  path: '/api/categoryinfo'
});

// 图片 / 视频 / 文档 / 种子列表
// https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取图片列表.md
// 这一族用 page / num 分页，不是 start / limit —— 和上面几个接口不一样，容易写错。
// 不传 page 时是不分页模式，一次返回全部。
export interface MediaListParams {
  parent_path?: string;
  /** 页码从 1 开始；不传则不分页 */
  page?: number;
  /** 每页数量，默认 1000 */
  num?: number;
  order?: 'time' | 'name' | 'size';
  desc?: 0 | 1;
  recursion?: 0 | 1;
  web?: 0 | 1;
}

export interface MediaListResult {
  errno: number;
  info: PanFile[];
}

function mediaList(method: 'imagelist' | 'videolist' | 'doclist' | 'btlist') {
  return describeApi<MediaListParams, MediaListResult>({
    path: '/rest/2.0/xpan/file',
    fixedQuery: { method }
  });
}

export const IMAGE_LIST = mediaList('imagelist');
export const VIDEO_LIST = mediaList('videolist');
export const DOC_LIST = mediaList('doclist');
export const BT_LIST = mediaList('btlist');

// 搜索文件（语义搜索） https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/搜索文件（语义搜索）.md
// POST 但参数全在查询串里，请求体是 {}（Content-Type: application/json）
export interface UniSearchParams {
  /** 固定 mcpserver */
  scene: string;
  query: string;
  /** 搜索路径，默认 ["/"] */
  dir?: string[];
  category?: FileCategory[];
  /** 返回上限，默认 500 */
  num?: number;
  /** 0 简单搜索 1 语义搜索 2 自动（5 字以上走语义） */
  search_type?: 0 | 1 | 2;
  sources?: number[];
}

export interface UniSearchResult {
  errno: number;
  list?: PanFile[];
}

export const UNISEARCH = describeApi<UniSearchParams, UniSearchResult>({
  method: 'POST',
  path: '/xpan/unisearch',
  paramsIn: 'query'
});

// ============ 上传 ============
// 三步上传：预上传 → 分片上传 → 创建文件。小文件可以走单步上传，一次请求搞定。
//
// 实测的两件要紧事：
// 1. 上传域名侧（superfile2 / 单步上传）和 pan.baidu.com 是两个 base，需要两个 client
// 2. 上传链路全程没有 CORS 响应头，浏览器必须经同源代理

// 预上传 https://pan.baidu.com/union/doc/基础网盘服务/上传/预上传.md
// block_list 是各分片 MD5（32 位小写）；小于 4MB 时只放整体 MD5
export interface PrecreateParams {
  path: string;
  size: number;
  isdir: 0 | 1;
  /** 本接口固定为 1 */
  autoinit: 1;
  /** JSON 字符串数组，由 toSearchParams 自动序列化 */
  block_list: string[];
  /** 1 冲突重命名、2 冲突且 block_list 不同时重命名、3 覆盖同名 */
  rtype?: 0 | 1 | 2 | 3;
  'content-md5'?: string;
  'slice-md5'?: string;
}

export interface PrecreateResult {
  errno: number;
  uploadid: string;
  /** 需要上传的分片序号；return_type 为 2 时可能为空 */
  block_list?: number[];
  /** 1 需要上传分片、2 秒传命中可直接结束 */
  return_type?: 1 | 2;
}

export const PRECREATE = describeApi<PrecreateParams, PrecreateResult>({
  method: 'POST',
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'precreate' }
});

// 创建文件 https://pan.baidu.com/union/doc/基础网盘服务/上传/创建文件.md
// 和 CREATE_FOLDER 同一个 method=create，参数不同：这里要 uploadid + block_list。
// block_list 用分片上传返回的云端 MD5，不是本地算的那份。
export interface UploadCreateParams {
  path: string;
  size: number;
  isdir: 0 | 1;
  uploadid: string;
  block_list: string[];
  rtype?: 0 | 1 | 2 | 3;
}

export interface UploadCreateResult {
  errno: number;
  fs_id: number;
  path: string;
  size: number;
  md5?: string;
  ctime?: number;
  mtime?: number;
}

export const UPLOAD_CREATE = describeApi<UploadCreateParams, UploadCreateResult>({
  method: 'POST',
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'create' }
});

// 分片上传 https://pan.baidu.com/union/doc/基础网盘服务/上传/分片上传.md
// 走上传域名，不是 pan.baidu.com。文件内容用 multipart 发，所以 file 不走 toSearchParams。
export interface Superfile2Params {
  path: string;
  uploadid: string;
  partseq: number;
}

export interface Superfile2Result {
  /** 云端算出的分片 MD5，create 的 block_list 用这个 */
  md5: string;
  request_id?: string;
}

export const SUPERFILE2 = describeApi<Superfile2Params, Superfile2Result>({
  method: 'POST',
  path: '/rest/2.0/pcs/superfile2',
  fixedQuery: { method: 'upload', type: 'tmpfile' },
  paramsIn: 'query'
});

// 单步上传 https://pan.baidu.com/union/doc/基础网盘服务/上传/单步上传.md
// 一次请求完成上传和创建，不需要任何 MD5，小文件走这条省两次往返。
// 实测返回的 md5 字段不是合法 hex（出现过 be7911c5co1ff...，第 10 位是字母 o），别拿它校验。
export interface SingleUploadParams {
  path: string;
  ondup?: 'fail' | 'overwrite' | 'newcopy';
}

export interface SingleUploadResult {
  fs_id: number;
  path: string;
  size: number;
  md5?: string;
  ctime?: number;
  mtime?: number;
}

export const SINGLE_UPLOAD = describeApi<SingleUploadParams, SingleUploadResult>({
  method: 'POST',
  path: '/rest/2.0/pcs/file',
  fixedQuery: { method: 'upload' },
  paramsIn: 'query'
});
