# Changelog

本项目的所有重要变更都记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，以根目录 `VERSION` 文件为准。

## [0.1.0] - 2026-11-06

首个公开发布版本。单包 `baidu-drive-sdk-js`，ESM，TypeScript 类型完整，零 React 依赖，以 Apache-2.0 发布。

分层与 [`baidu-drive-sdk-go`](https://github.com/baidu-netdisk/baidu-drive-sdk-go) 对齐：`api` 层（协议、传输、端点、错误码、授权）+ `scene` 层（业务编排）。

### Added

- **包结构与导出**（10 个入口，单包 + 子路径）
  - 聚合入口 `baidu-drive-sdk-js`
  - api 层：`baidu-drive-sdk-js/api`、`baidu-drive-sdk-js/api/auth`、`baidu-drive-sdk-js/api/auth/vite`
  - scene 层：`baidu-drive-sdk-js/scene`、`baidu-drive-sdk-js/scene/file-browse`、`/scene/file-manage`、`/scene/file-upload`、`/scene/file-download`、`/scene/user-info`
  - 基于 tsup 的多入口构建，每个入口独立产出 ESM 与 `.d.ts`
- **api 层**
  - 传输层：超时、`AbortSignal` 取消、`network` / `timeout` / `abort` / `http` / `parse` 五类错误
  - 客户端工厂 `createClient`：`baseUrl`、凭证来源、解析与校验钩子均可注入
  - 开放平台适配 `createOpenApi`：`access_token` 注入、`errno` 校验（`ApiError`）、`request_id` 大整数转字符串、`defineApi` 绑定端点
  - 端点描述（纯数据）：用户信息、容量、文件列表、递归列表、文件信息（fsid / path）、搜索（关键词 / 语义）、分类列表与分类统计、文件管理（复制 / 移动 / 重命名 / 删除）、创建文件夹、预上传、分片上传、创建文件、单步上传
  - `errno` 中文文案表、`needsReauth` 判定、`apiErrno(error)` 统一取值
  - `Errno` 常用错误码常量（命名与 Go SDK 的 `api.Errno*` 对应，只收录语义明确的码）与 `ErrnoValue` 类型
  - `isErrno(error, errno)`：同时识别 `ApiError.errno` 与 `HttpError.body.error_code`，传入非错误对象返回 `false`
  - `withRetry`：默认 3 次、退避 300ms 起，只重试网络错误、5xx、`31034`、`111`
  - 授权（`api/auth`）：简化模式（implicit，`response_type=token`）、`popup` / `tab` 两种打开方式、`state` 与来源校验、超时与取消、凭据缓存（过期提前量、scope 子集判定、按 app 隔离）
  - `api/auth/vite`：Vite 插件，dev 中间件 + build asset 产出授权回调页；dev 回调页路由跟随 Vite `base`（应用挂在子路径时无需额外配置），也可用 `base` 参数显式指定
- **scene 层**
  - `createScene({ api, transfer, proxyPrefix?, computeMd5? })`：把所有场景方法摊平到同一个对象上；也接受裸 `OpenApi`；不传 `transfer` 时 `upload` 以 `ConfigError` reject
  - `file-browse`：`listDir` / `listAll` / `listTree` / `search` / `searchSemantic` / `byCategory` / `categoryStats` / `images` / `videos` / `docs` / `torrents`，自动补 `start`、自动翻页、文件名解码、瞬时错误重试
  - `file-manage`：`exists` / `mkdirIfNotExist` / `copy` / `move` / `rename` / `remove`，操作前存在性检查、`info[]` 逐条 `errno` 翻译、幂等建目录
  - `file-upload`：`upload` 按大小自动选路（≤4MB 单步、>4MB 三步分片）、进度回调、秒传分支、分片 MD5 计算（`spark-md5`）
  - `file-download`：`meta` / `downloadUrl` / `sameOriginUrl` / `fetchBlob` / `saveAs`，区分导航下载与 `fetch` 读字节两种限制
  - `user-info`：`profile` / `quota` / `overview`、`vipLabel`、`formatBytes`，补出 `available` 与 `usedRatio`
- **示例**
  - `examples/react-file-browser`：React + Vite 的网盘目录浏览器，演示简化模式授权登录、目录浏览（含面包屑）、用户头像与昵称展示、文件大小与时间格式化
- **文档**
  - `README.md`、`docs/architecture.md`（api/scene 分层与装配）、`docs/pitfalls.md`（接口坑位合集）、`docs/proxy.md`（同源代理配置）
  - `CONTRIBUTING.md`、`SECURITY.md`、`THIRD_PARTY_NOTICES.md`
- **工程与发布**
  - GitHub Actions CI：Conventional Commits 校验、敏感文件检查、硬编码凭据检查、`type-check` / `test` / `build`、产物冒烟、`publint`、示例构建
  - `VERSION` 驱动的 Release 工作流：自动打 tag、创建 GitHub Release，配置 `NPM_TOKEN` 时自动发布到 npm
  - `scripts/check-version.mjs`：CI 与发布前校验 `VERSION` 与 `package.json` 版本一致
  - `THIRD_PARTY_NOTICES.md` 记录运行时依赖（`spark-md5`）及其许可证
- **测试**
  - Vitest 单测覆盖 api 层（开放平台适配、`errno`、重试）与 scene 层全部场景；单测只使用假端点，不访问真实接口

### License

- 以 [Apache-2.0](./LICENSE) 发布。
