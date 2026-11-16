// scene 层：业务场景编排。每个方法是「用户心里的一件事」，内部负责补默认值、
// 自动翻页、前置检查、逐条错误翻译和瞬时错误重试。
//
// 对应 Go SDK 的 `baidudriver/scene` 包：
//
//   Go:    client := api.NewClient(api.WithAccessToken(token))
//          sc := scene.New(client)
//          files, err := sc.ListDir(ctx, "/", nil)
//
//   TS/JS: const api = createOpenApi({ tokenStore })
//          const sc = createScene({ api, transfer })
//          const files = await sc.listDir('/')
//
// 也可以跳过聚合层，直接按场景引入（`./file-browse` 等），做更细的裁剪。

import { ConfigError } from '../api';
import { createFileBrowse } from './file-browse';
import { createFileDownload } from './file-download';
import { createFileManage } from './file-manage';
import { createFileUpload } from './file-upload';
import { createUserInfo } from './user-info';
import type { OpenApi } from '../api';
import type { FileBrowse } from './file-browse';
import type { FileDownload } from './file-download';
import type { FileManage } from './file-manage';
import type { FileUpload } from './file-upload';
import type { UserInfo } from './user-info';

export * from './file-browse';
export * from './file-manage';
export * from './file-upload';
export * from './file-download';
export * from './user-info';

export interface SceneConfig {
  /** 主接口实例，通常 `createOpenApi({ tokenStore })`，baseUrl 默认 '/pan' */
  api: OpenApi;
  /**
   * 上传/下载域名实例，通常 `createOpenApi({ tokenStore, baseUrl: '/pcs' })`。
   * 不传时上传方法会抛 `ConfigError`；纯读场景（列表、搜索、用户信息）不需要它。
   */
  transfer?: OpenApi;
  /** 下载的同源代理前缀，默认 '/pcs' */
  proxyPrefix?: string;
  /** 覆盖分片 MD5 实现，默认 spark-md5 */
  computeMd5?: (blob: Blob) => Promise<string>;
}

/**
 * scene 聚合层：把所有场景方法摊平到同一个对象上，一个实例调完所有事。
 *
 * 各场景包之间没有重名方法，所以可以安全合并；需要更细的依赖边界时，
 * 直接 import 对应的 `./file-*` 工厂自己装配即可。
 */
export interface Scene extends FileBrowse, FileManage, FileUpload, FileDownload, UserInfo {}

// 声明成 async：upload 的契约是「返回 Promise」，同步抛会让调用方的 .catch / await 都接不到。
async function missingTransfer(): Promise<never> {
  throw new ConfigError(
    'createScene 缺少 transfer 实例：上传需要 /pcs 域的 OpenApi，' +
      '请先 createOpenApi({ tokenStore, baseUrl: "/pcs" }) 再传进来'
  );
}

export function createScene(config: SceneConfig | OpenApi): Scene {
  const options: SceneConfig = 'defineApi' in config ? { api: config } : config;
  const { api, transfer } = options;

  const browse = createFileBrowse(api);
  const manage = createFileManage(api);
  const user = createUserInfo(api);
  const download = createFileDownload(api, { proxyPrefix: options.proxyPrefix });
  const upload: FileUpload =
    transfer === undefined
      ? { upload: missingTransfer }
      : createFileUpload({ api, upload: transfer, computeMd5: options.computeMd5 });

  return { ...browse, ...manage, ...user, ...download, ...upload };
}
