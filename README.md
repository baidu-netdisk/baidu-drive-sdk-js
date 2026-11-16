# Baidu Netdisk JavaScript SDK

[![CI](https://github.com/baidu-netdisk/baidu-drive-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/baidu-netdisk/baidu-drive-sdk-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

百度网盘 JavaScript/TypeScript SDK，对齐[百度网盘开放平台](https://pan.baidu.com/union/doc/zksg0sb9z)最新 API。

> **语言与运行环境**
>
> - **源码是 TypeScript**（`src/**/*.ts`，`strict` 全开），不是纯 JavaScript。`src/` 下唯一的 `.js` 是 `src/api/auth/vite.mjs`——Vite 插件必须能被 Node 直接加载，原因见该文件头；`scripts/` 里的构建脚本同样是手写 JS，不进发布产物。
> - **产物是 ESM JavaScript**（`.js`）+ **完整类型声明**（`.d.ts` / `.d.mts`），所以 JS 和 TS 项目都能直接用。
> - **运行在浏览器**（ES2022）；Node.js 只用于构建、类型检查与测试，SDK 运行时不依赖 Node。
>
> 因此包名里的 `-js` 指的是「JS/TS 生态 + JS 产物」，既不是说源码是纯 JavaScript，也不代表这是 Node SDK。

## 安装

npm 包尚未发布，当前请从 GitHub 源安装（首次安装会现场构建，需要能访问 GitHub）：

```bash
# 推荐 pnpm
pnpm add git+https://github.com/baidu-netdisk/baidu-drive-sdk-js.git

# npm 用户需要 npm 11 及以上
npm install github:baidu-netdisk/baidu-drive-sdk-js
```

> 发布到 npm 后会改为 `npm install baidu-drive-sdk-js`。npm 10 从 git 安装依赖存在已知的 arborist 报错（与本包无关），遇到请升级 npm 或改用 pnpm。

**要求**

- **运行环境：浏览器**（ES2022）。依赖 `fetch`、`FormData`、`Blob`、`URL`、`AbortController`、`crypto.getRandomValues`、`localStorage`。
- **Node.js ≥ 18.17**，仅用于构建、类型检查与测试；SDK 运行时不依赖 Node。
- **ESM only**：包是 `"type": "module"`，只提供 `import` 入口；CommonJS 环境请用 `await import('baidu-drive-sdk-js')`。

## 快速开始

浏览器直连开放平台会被 CORS 拦掉，所以先准备好**同源代理**与**授权回调页插件**（分别见[同源代理](#同源代理)和下方「认证 (Auth)」）。然后按三步装配，跑通「授权 → 列目录 → 展示用户信息」。

### 1. 配置 AppKey

AppKey 是公开标识，会出现在授权 URL 里，不是密钥：

```bash
# .env.local
VITE_PAN_APP_KEY=your-app-key
```

> **SecretKey / client_secret 一个字符都不要放进前端代码或 `VITE_*` 变量**——浏览器侧走简化模式，用不到它，也绝不该持有它。

### 2. 装配 auth、api 与 scene

```ts
// src/pan.ts
import { createAuth } from 'baidu-drive-sdk-js/api/auth';
import { createOpenApi } from 'baidu-drive-sdk-js/api';
import { createScene } from 'baidu-drive-sdk-js/scene';

// 开放平台控制台登记的应用名，决定你能读写的目录 /apps/<应用名>
export const APP_DIR = '/apps/your-app-name';

export const auth = createAuth({
  appKey: import.meta.env.VITE_PAN_APP_KEY,
  // 必须与开放平台控制台登记的回调地址逐字符一致
  redirectUri: window.location.origin + '/oauth-callback.html',
  mode: 'tab'
});

// 主接口实例，baseUrl 默认 '/pan'
export const api = createOpenApi({ tokenStore: auth.tokenStore });

// 上传/下载域名是另一个 origin，需要第二个实例；纯读场景可以省掉这一行
export const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' });

// scene 层：所有业务方法摊平在同一个对象上
export const sc = createScene({ api, transfer });
```

### 3. 列目录 + 展示用户信息

页面上放一个按钮触发授权：`<button id="login">登录百度网盘</button>`。

```ts
// src/main.ts
import { formatBytes } from 'baidu-drive-sdk-js/scene/user-info';
import { APP_DIR, auth, sc } from './pan';

async function load() {
  // 有可用缓存直接返回，没有才拉起授权页；过期后同样走这里重新授权
  await auth.authorize();

  const { profile, quota } = await sc.overview();
  console.log(profile.displayName, '·', profile.vipLabel);
  console.log(`${formatBytes(quota.used)} / ${formatBytes(quota.total)}（剩余 ${formatBytes(quota.available)}）`);

  // limit 会自动配上 start；文件名/路径已解码，渲染用 name / decodedPath
  const files = await sc.listDir(APP_DIR, { limit: 20 });
  for (const file of files) {
    console.log(file.name, file.isdir ? '[目录]' : formatBytes(file.size));
  }
}

// 授权会打开新窗口，必须由用户点击触发，否则会被浏览器当成弹窗拦掉
document.querySelector('#login')?.addEventListener('click', () => {
  load().catch((error) => console.error(error));
});
```

跑通之后你会看到：当前用户的昵称与会员等级、已用/总容量、以及应用目录下的文件列表。`APP_DIR` 里的 `your-app-name` 要换成开放平台控制台登记的应用名，填错会得到 `errno 20020`。

## 架构

SDK 分为两层，与 [`baidu-drive-sdk-go`](https://github.com/baidu-netdisk/baidu-drive-sdk-go) 的 `api` / `scene` 结构一一对应：

- **scene 层**（`baidu-drive-sdk-js/scene`）— **推荐使用**。业务场景封装，提供自动重试、多接口串联、前置检查、自动翻页、文件名解码等高层能力
- **api 层**（`baidu-drive-sdk-js/api`）— 底层接口调用，与开放平台接口一一对应，适合需要精细控制的场景；**授权（Auth）也在这一层**，与 Go SDK 一致

```
scene（业务层，推荐）   createScene({ api, transfer })
  └── api（接口层）      createOpenApi({ tokenStore })
        └── HTTP         fetch + 同源代理
              └── 百度网盘开放平台
```

依赖方向是单向的：`scene` 只依赖 `api`，`api` 不含任何业务编排。聚合入口 `baidu-drive-sdk-js` 只是把两层 `export *` 摊平，不改变依赖方向。

**没有默认实例**：`api` 与 `scene` 都必须由你的应用显式装配。一个页面里可能同时存在多个 app、多个账号，模块级单例会串 token；SSR 场景下更会在进程内跨请求串号。

## Scene 业务层（推荐）

scene 层基于 api 层封装，把「用户心里的一件事」做成一个方法：自动重试（指数退避）、前置检查、多接口串联、逐条错误翻译。**大多数场景下推荐直接使用 scene 层。**

```ts
import { createOpenApi } from 'baidu-drive-sdk-js/api';
import { createScene } from 'baidu-drive-sdk-js/scene';

const api = createOpenApi({ tokenStore: auth.tokenStore });
const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' });
const sc = createScene({ api, transfer });
```

`createScene` 也接受裸 `OpenApi`，等价于只装配读场景：

```ts
const sc = createScene(api);   // 等价于 createScene({ api })
```

不传 `transfer` 时，列表、搜索、用户信息等读方法照常可用；**只有 `upload` 会 reject `ConfigError`**，提示缺少 `/pcs` 域的实例。

### 用户信息

```ts
// 页头一次拿齐：昵称、头像、会员文案、已用/总量
const { profile, quota } = await sc.overview();

console.log(profile.displayName);          // 渲染用户名用这个（netdiskName 可能为空串）
console.log(profile.vipLabel);             // 普通用户 / 普通会员 / 超级会员
console.log(formatBytes(quota.used) + ' / ' + formatBytes(quota.total));
console.log(formatBytes(quota.available)); // 剩余可用 = total - used，接口不给

// 只需要其中一半时分别调用
const me = await sc.profile();
const space = await sc.quota();            // 自动带 checkfree=1&checkexpire=1
```

### 文件浏览与搜索

```ts
// 目录列表（自动补 start，单次最多 1000 条）
const files = await sc.listDir('/', { order: 'time', desc: true, limit: 10 });

// 目录下全部条目（自动翻页，突破单次上限）
const all = await sc.listAll('/apps/myapp');

// 连子目录一起递归列出（走 listall，用 cursor 翻页）
const tree = await sc.listTree('/apps/myapp');

// 关键词搜索（默认递归整个目录树）
const { files: hits, hasMore } = await sc.search('合同', { category: 4 });

// 自然语言搜索（"找去年的合同"这类描述性查询）
const semantic = await sc.searchSemantic('找去年的合同', { dirs: ['/documents'] });

// 「我的图片 / 视频 / 文档」入口
const pics = await sc.images({ page: 1, num: 50 });
```

### 上传与下载

```ts
// file 来自 <input type="file">：const file = input.files[0]
// fsId 来自 sc.listDir / sc.search 返回的 fs_id

// 一键上传：≤4MB 自动走单步上传，>4MB 自动走 precreate → 分片 → create
const result = await sc.upload(file, `/apps/myapp/${file.name}`, {
  ondup: 'overwrite',
  onProgress: ({ ratio }) => console.log(Math.round(ratio * 100) + '%')
});
console.log(result.via);   // 'single' | 'slice' | 'rapid'

// 一键下载到本地：走浏览器导航，不需要代理
await sc.saveAs(fsId);

// 预览图片、播视频：资源加载不受 CORS 限制，直接贴 dlink（img 是页面上的 <img>）
img.src = await sc.downloadUrl(fsId);

// 把字节读进 JS（校验、解析、canvas）：需要 /pcs 同源代理
const blob = await sc.fetchBlob(fsId);
```

### 文件管理

文件管理方法在操作前自动检查源文件是否存在，并把 `info[]` 里的逐条失败翻译成异常：

```ts
// 创建文件夹（已存在则跳过）
await sc.mkdirIfNotExist('/apps/myapp/backup');

// 复制、移动、重命名
await sc.copy('/a.txt', '/apps/myapp/backup');
await sc.move('/a.txt', '/apps/myapp/archive', 'a-2026.txt');
await sc.rename('/old.txt', 'new.txt');

// 删除（路径数组；没有回收站语义保证）
await sc.remove(['/trash.txt']);

// 路径是否存在（"不存在"是正常返回值，不是异常）
console.log(await sc.exists('/a.txt'));
```

### Scene 方法一览

| 方法 | 说明 |
| --- | --- |
| `profile()` | 用户资料（昵称、头像、会员等级） |
| `quota()` | 网盘容量（总量、已用、剩余可用、到期提醒） |
| `overview()` | 资料 + 容量并发查询，页头一次拿齐 |
| `listDir(dir, opts?)` | 目录文件列表（自动补 `start`，文件名已解码） |
| `listAll(dir, opts?)` | 目录下全部条目（自动翻页） |
| `listTree(dir, opts?)` | 递归列出整棵子树（`cursor` 翻页） |
| `search(keyword, opts?)` | 关键词搜索（默认递归） |
| `searchSemantic(query, opts?)` | 语义/自然语言搜索 |
| `byCategory(category, opts?)` | 按分类取文件，支持扩展名过滤 |
| `categoryStats(category, opts?)` | 分类下的文件数与占用空间 |
| `images/videos/docs/torrents(opts?)` | 图片 / 视频 / 文档 / 种子列表 |
| `upload(blob, path, opts?)` | 一键上传（自动选路 + 分片 + 进度） |
| `saveAs(fsId, filename?)` | 触发浏览器下载（导航，无需代理） |
| `downloadUrl(fsId, opts?)` | 取带 `access_token` 的 dlink |
| `sameOriginUrl(dlink)` | 把 dlink 换成同源代理地址 |
| `fetchBlob(fsId, opts?)` | 经同源代理把文件读进 JS |
| `meta(fsId, opts?)` | 文件元信息（名称、大小、MD5、dlink） |
| `exists(path)` | 路径是否存在 |
| `mkdirIfNotExist(path, opts?)` | 幂等建目录 |
| `copy/move(from, toDir, newName?, opts?)` | 复制 / 移动（带前置检查） |
| `rename(path, newName, opts?)` | 重命名 |
| `remove(paths, opts?)` | 批量删除 |

## 认证 (Auth)

浏览器侧只能使用 **OAuth 2.0 简化模式（implicit，`response_type=token`）**：不需要 SecretKey，token 由百度直接带回回调页。

```ts
import { createAuth } from 'baidu-drive-sdk-js/api/auth';

const auth = createAuth({
  appKey: import.meta.env.VITE_PAN_APP_KEY,      // 公开标识，不是密钥
  redirectUri: window.location.origin + '/oauth-callback.html',
  mode: 'tab'                                     // 默认 'popup'
});

// 有可用缓存直接返回，否则拉起授权页
const { credential, fromStore } = await auth.authorize();
console.log(credential.expiresAt, fromStore);

// 交给 api 层当凭证来源
const api = createOpenApi({ tokenStore: auth.tokenStore });
```

回调页不用自己写，用 Vite 插件产出（dev 时由中间件提供，build 时作为静态 asset 产出）：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { panOauthCallback } from 'baidu-drive-sdk-js/api/auth/vite';

export default defineConfig({
  plugins: [panOauthCallback()]
});
```

`panOauthCallback()` 默认产出 `oauth-callback.html`，文件名要与开放平台登记的 `redirectUri` 路径一致。
应用挂在子路径（Vite `base`，如 `/my-app/`）时无需额外配置：插件会读 `server.config.base`，dev 下的回调页路由自动带前缀（`/<base>/oauth-callback.html`）。

### 两种打开方式

| `mode` | 行为 | 适用 |
| --- | --- | --- |
| `popup`（默认） | 小窗 `480×680`，`display=popup` | 需要保持当前页面上下文 |
| `tab` | 新标签页整页授权，`display=page` | **推荐**：可复用浏览器里已有的百度登录态，也不容易被当成弹窗拦截 |

回调结果会**同时**通过 `postMessage` 和 `localStorage` 回传，两条路都监听，浏览器断掉 `opener` 时也能收到；5 分钟没回来按超时处理，用户关掉窗口按取消处理。

### 为什么不支持授权码模式

授权码模式换取 token 必须带 `client_secret`，而 SecretKey 不能出现在浏览器（会被打进产物、被抓包、被 XSS 读取）。浏览器侧因此只做简化模式，这也是它和 Go SDK 的差异：Go SDK 跑在服务端，支持授权码、设备码和 `refresh_token` 刷新；浏览器侧**拿不到 `refresh_token`**，token 过期后只能重新授权。

`auth` 暴露的其他能力：

```ts
auth.load();                    // 读缓存的 Credential，没有则 null
auth.logout();                  // 清除本地缓存
auth.saveManualToken(token);    // 手填 token 的调试兜底
```

凭据默认存在 `localStorage`（key 由 appKey + 回调地址 + scope 哈希而来，用于多应用隔离，不是加密）。任何能在同源执行的 JS 都能读到它，所以应用侧必须做好 XSS 防护；需要更严格的隔离时，可以注入自己的 `CredentialStore`（见[客户端选项](#客户端选项)）。

## 错误处理

```ts
// sc / auth 来自「快速开始」里装配好的实例
import { ApiError, ConfigError, Errno, HttpError, isErrno } from 'baidu-drive-sdk-js/api';

try {
  await sc.listDir('/apps/myapp');
} catch (error) {
  // 凭据失效：简化模式没有 refresh_token，只能重新授权
  if (isErrno(error, Errno.AccessTokenExpired) || isErrno(error, Errno.AccessDenied)) {
    auth.logout();
    await auth.authorize();
    return;
  }

  // "文件不存在"是预期分支，不必当异常抛给用户
  if (isErrno(error, Errno.PathNotExist)) {
    return [];
  }

  if (error instanceof ApiError) {
    // HTTP 200，业务失败：errmsg 是接口原文，requestId 用于对平台日志
    console.error(error.errno, error.message, error.errmsg, error.requestId);
  } else if (error instanceof HttpError) {
    // 传输层：network / timeout / abort / http / parse
    console.error(error.kind, error.status, error.url);
  } else if (error instanceof ConfigError) {
    // 装配问题：没有可用 token、缺少 transfer 实例等
    console.error(error.message);
  } else {
    throw error;
  }
}
```

两个容易踩的边界：

- **`HttpError.url` 已脱敏**：`access_token` 以及 `token` / `bduss` / `stoken` 等常见别名会被替换成 `***`，错误对象可以直接进日志与监控，不会把用户凭据带出去。
- **分页截断会抛错**：`listAll` / `listTree` 达到翻页上限时抛 `BrowseTruncatedError`（从 `baidu-drive-sdk-js/scene/file-browse` 导出），不再静默返回半份数据。目录确实很大时传 `{ maxPages }` 放宽。

- `ApiError.message` 是 SDK 维护的中文说明（来自 `errnoMessage`），可以直接展示；接口原文在 `errmsg` 上。
- **业务错误有两个载体**：HTTP 200 + `errno`（`ApiError`），以及非 2xx + `body.error_code`（`HttpError`）。`isErrno(error, errno)` 同时认这两个载体；传入的不是错误对象（比如 `null`）返回 `false`。
- `HttpError.kind === 'parse'` 通常意味着代理配错了、返回了 `index.html`。

### 常用错误码

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `Errno.Success` | `0` | 请求成功 |
| `Errno.AccessDenied` | `-6` | 身份验证失败，请重新授权 |
| `Errno.FileNameIllegal` | `-7` | 文件或目录名有误，或无权访问 |
| `Errno.FileAlreadyExist` | `-8` | 文件或目录已存在 |
| `Errno.PathNotExist` | `-9` | 文件或目录不存在 |
| `Errno.SpaceFull` | `-10` | 云端容量已满 |
| `Errno.ParamError` | `2` | 参数错误 |
| `Errno.AsyncTaskRunning` | `111` | 有其他异步任务正在执行，请稍后重试 |
| `Errno.AccessTokenExpired` | `20016` | access_token 已过期，请重新授权 |
| `Errno.AccessTokenInvalid` | `20017` | access_token 无效，请重新授权 |
| `Errno.LimitExceeded` | `31034` | 命中接口频控，请降低请求频率 |
| `Errno.AccessTokenVerifyFailed` | `31045` | access_token 验证未通过 |

```ts
import { Errno, isErrno } from 'baidu-drive-sdk-js/api';

if (isErrno(error, Errno.AccessTokenExpired)) {
  auth.logout();
  await auth.authorize();
}
```

`Errno` 只收录语义明确、且平台「公共错误码」表与 Go SDK 含义一致的码。含义有歧义的码（比如 `31023`、`31190`）不定义常量，用 `errnoMessage(errno)` 取通用文案；表外的码（如 `20020`、`31061`、`31064`、`31066`、`31299`）同样按数值判断或走 `errnoMessage`。常量值的联合类型是 `ErrnoValue`。

`needsReauth(errno)` 覆盖 `-6`、`20016`、`20017`、`31045`（即 `Errno.AccessDenied`、`Errno.AccessTokenExpired`、`Errno.AccessTokenInvalid`、`Errno.AccessTokenVerifyFailed`），命中的错误重试没有意义。

## 客户端选项

```ts
import { createOpenApi } from 'baidu-drive-sdk-js/api';
import { createScene } from 'baidu-drive-sdk-js/scene';
import { md5OfBlob } from 'baidu-drive-sdk-js/scene/file-upload';

const api = createOpenApi({
  baseUrl: '/pan',                  // 默认 DEFAULT_BASE_URL（'/pan'）；同源部署可传 ''
  tokenStore: auth.tokenStore,      // 任何 { get, set, clear }
  timeout: 15000                    // 单次请求超时，默认 15000ms
});

// 上传/下载域名（d.pcs.baidu.com）是另一个 base
const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' });

const sc = createScene({
  api,
  transfer,
  proxyPrefix: '/pcs',              // 下载同源地址的前缀，默认 '/pcs'
  computeMd5: md5OfBlob             // 覆盖分片 MD5 实现，默认 spark-md5
});
```

可注入的凭据存储（`api/auth` 导出）：

```ts
import { createAuth, createMemoryCredentialStore } from 'baidu-drive-sdk-js/api/auth';

const auth = createAuth({
  appKey,
  redirectUri,
  store: createMemoryCredentialStore()   // 刷新即丢，适合测试或多账号隔离
});
```

`CredentialStore` 只有三个方法 `load / save / remove`，可以换成 `sessionStorage`、内存或你自己的状态管理。

### 超时与取消

- `timeout` 是每次请求的超时，单位毫秒。
- 上传、下载等耗时操作接受 `signal: AbortSignal`：

```ts
const controller = new AbortController();
await sc.upload(file, path, { signal: controller.signal });
controller.abort();   // 取消
```

- 每个 scene 方法都接受 `retry` 覆盖默认重试策略（默认 3 次、退避 300ms 起）：

```ts
await sc.listDir('/', { retry: { attempts: 5, baseDelayMs: 500 } });
```

重试白名单是网络错误、超时、5xx、`errno 31034`、`errno 111`；`-6` / `-9` 这类重试无意义的错误不会重试。

## 同源代理

浏览器访问开放平台只有一条路：**同源代理**。开放平台接口和上传/下载域名都不返回 `Access-Control-Allow-Origin`，`fetch` 直连会被浏览器拦掉。

| 前缀 | 上游 | 覆盖 |
| --- | --- | --- |
| `/pan` | `https://pan.baidu.com` | 用户信息、容量、列表、搜索、文件管理、预上传、创建文件 |
| `/pcs` | `https://d.pcs.baidu.com` | 分片上传、单步上传、dlink 下载 |

Vite dev 的最小配置：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { panOauthCallback } from 'baidu-drive-sdk-js/api/auth/vite';

export default defineConfig({
  plugins: [panOauthCallback()],
  server: {
    proxy: {
      '/pan': {
        target: 'https://pan.baidu.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pan/, '')
      },
      '/pcs': {
        target: 'https://d.pcs.baidu.com',
        changeOrigin: true,
        followRedirects: true,   // dlink 会 302 到 CDN，读字节时由 dev server 跟随
        rewrite: (path) => path.replace(/^\/pcs/, '')
      }
    }
  }
});
```

两条容易配错的规则：

- **按前缀整体转发，不要逐条枚举接口**。`/api/quota`、`/api/categoryinfo` 不在 `/rest/2.0/xpan` 下，逐条枚举一定会漏。
- **代理没命中时 SPA 兜底会返回 `index.html`**（HTTP 200）。SDK 会把它报成 `HttpError`（`kind: 'parse'`），不会让你拿到"成功但数据为空"的假象。

Nginx、静态托管 `routes`、同源部署（`baseUrl: ''`）与验证方法见 [docs/proxy.md](docs/proxy.md)。

## 常见坑

完整清单与实测细节在 [docs/pitfalls.md](docs/pitfalls.md)，这里保留最影响上手的七条：

1. **必须经同源代理**。开放平台接口和 `d.pcs.baidu.com` 都不返回 CORS 头，`fetch` 直连会被浏览器拦掉；线上没有 rewrite 就等于整个 SDK 不可用。
2. **`errno` 藏在两个地方**。失败响应可能是 HTTP 200 + `errno`，也可能是非 2xx + `body.error_code`；判断错误码一律用 `apiErrno(error)`。
3. **三套分页模型不能混用**。`list` 用 `start` + `limit`，`listall` 用响应里的 `cursor`，`imagelist` 那族用 `page` + `num` 且结果在 `info` 字段。
4. **`limit` 单独传会被忽略**。实测 `limit=10` 返回 1000 条，`start=0&limit=10` 才返回 10 条；`listDir` 已自动补 `start`。
5. **文件名和路径是 URL 编码的**。接口返回 `%E5%B7%A5%E5%85%B7...`，渲染用 `BrowseFile.name` / `decodedPath`，不要用原始字段。
6. **`free` 不是剩余空间**。`free` 是免费容量，剩余可用是 `total - used`；SDK 已算好放在 `quota.available`。
7. **大目录不会静默给半份**。`listAll` / `listTree` 默认最多翻 50 页，超过抛 `BrowseTruncatedError`；`listAll` 还会把页大小夹到平台上限 1000，避免「传 2000 只返回 1000 就被当成最后一页」。

## API 底层接口

以下为 api 层的端点级用法，适合需要精细控制请求参数的高级用户。**一般场景推荐使用 scene 层**——底层接口不会自动翻页、不会解码文件名、不会把 `info[]` 的逐条失败翻译成异常。

```ts
import { createOpenApi, FILE_METAS, LIST_FILES, QUOTA, USER_INFO } from 'baidu-drive-sdk-js/api';

const api = createOpenApi({ tokenStore: auth.tokenStore });

// 端点描述是纯数据，用 defineApi 绑到实例上才可调用
const listFiles = api.defineApi(LIST_FILES);
const page = await listFiles({ dir: '/', start: 0, limit: 20 });

const userInfo = api.defineApi(USER_INFO);
const me = await userInfo();                      // { baidu_name, netdisk_name, vip_type, ... }

const quota = api.defineApi(QUOTA);
const space = await quota({ checkfree: 1, checkexpire: 1 });

// 批量查文件信息（fsid → 元信息；dlink=1 才会返回下载地址）
const fileMetas = api.defineApi(FILE_METAS);
const metas = await fileMetas({ fsids: [123456789], dlink: 1 });
```

文件管理、上传、下载同样是「描述 + 绑定」：

```ts
import {
  COPY_FILES, PRECREATE, SUPERFILE2, UPLOAD_CREATE
} from 'baidu-drive-sdk-js/api';
import { md5OfBlob, sliceFile } from 'baidu-drive-sdk-js/scene/file-upload';

// 文件管理：opera 在查询串、async/filelist 在表单体，SDK 已按接口拆好四个描述
const copyFiles = api.defineApi(COPY_FILES);
await copyFiles({ async: 0, filelist: [{ path: '/a.txt', dest: '/backup', newname: 'a_copy.txt' }] });

// 上传：三步流程 precreate → superfile2 → create
const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' });
const precreate = api.defineApi(PRECREATE);
const superfile2 = transfer.defineApi(SUPERFILE2);
const uploadCreate = api.defineApi(UPLOAD_CREATE);

// file 来自 <input type="file"> 选中的 Blob/File
const slices = sliceFile(file);
const localMd5s = await Promise.all(slices.map((slice) => md5OfBlob(slice)));
const pre = await precreate({
  path: '/apps/myapp/a.bin', size: file.size, isdir: 0, autoinit: 1, block_list: localMd5s
});

// create 的 block_list 要用云端返回的分片 MD5
const remoteMd5s = [...localMd5s];
for (const index of pre.block_list ?? []) {
  const uploaded = await superfile2(
    { path: '/apps/myapp/a.bin', uploadid: pre.uploadid, partseq: index },
    { multipart: { file: slices[index] } }
  );
  remoteMd5s[index] = uploaded.md5;
}

await uploadCreate({
  path: '/apps/myapp/a.bin', size: file.size, isdir: 0,
  uploadid: pre.uploadid, block_list: remoteMd5s
});
```

### API 方法一览

| 分类 | 导出 | 说明 |
| --- | --- | --- |
| 认证 | `createAuth`、`panOauthCallback` | 简化模式授权、凭据缓存、回调页 |
| 客户端 | `createOpenApi`、`createClient`、`describeApi` | 实例装配、端点绑定 |
| 用户与容量 | `USER_INFO`、`QUOTA` | 用户信息、容量（`/api/quota`） |
| 文件信息 | `LIST_FILES`、`LIST_ALL`、`FILE_METAS`、`FILE_META`、`SEARCH_FILES`、`UNISEARCH` | 目录列表、递归列表、文件元信息、关键词/语义搜索 |
| 分类 | `CATEGORY_LIST`、`CATEGORY_INFO`、`IMAGE_LIST`、`VIDEO_LIST`、`DOC_LIST`、`BT_LIST` | 分类列表、分类统计、媒体列表 |
| 文件管理 | `COPY_FILES`、`MOVE_FILES`、`RENAME_FILES`、`DELETE_FILES`、`CREATE_FOLDER` | 复制、移动、重命名、删除、建目录 |
| 上传 | `PRECREATE`、`SUPERFILE2`、`UPLOAD_CREATE`、`SINGLE_UPLOAD` | 预上传、分片上传、创建文件、单步上传 |
| 下载 | `FILE_METAS`（`dlink: 1`） | 取 dlink，之后由浏览器导航或 `fetch` 读取 |

## 示例

查看 [examples/react-file-browser](examples/react-file-browser)：一个用 React + Vite 写的网盘目录浏览器，演示简化模式授权登录、目录浏览（含面包屑）、用户头像与昵称展示、文件大小与时间格式化。

示例通过 workspace 引用 SDK 的 `dist/` 产物，所以**先在仓库根构建一次 SDK**：

```bash
pnpm install
pnpm build                                            # 先产出 dist/，否则示例解析不到 SDK

# AppKey 放在示例自己的 .env.local 里（从 .env.example 复制），详见该目录 README
pnpm --filter example-react-file-browser dev
```

其余脚本：`pnpm --filter example-react-file-browser <build|type-check|test>`。

示例不包含部署配置，上线时需要自备与[同源代理](#同源代理)等价的反向代理。

## 开发

```bash
pnpm install       # 安装依赖
pnpm type-check    # tsc --noEmit
pnpm test          # vitest run
pnpm build         # tsup 构建 + 拷贝手写静态文件到 dist/
```

### 持续集成与发布

CI 在每次 push / PR 时执行以下门禁：

| 门禁 | 说明 |
| --- | --- |
| Conventional Commits 校验 | PR 内 commit 必须符合 `feat(scope): subject` 格式 |
| 敏感文件检查 | 禁止提交 `.env`、`*.pem`、`*.key`、`credentials*` 等文件 |
| 硬编码凭据检查 | 禁止把 `secret_key` / `client_secret` / `access_token` 写进源码 |
| 版本一致性 | `scripts/check-version.mjs` 校验 `VERSION` 与 `package.json` 版本一致 |
| `type-check` / `test` / `build` | 类型检查、单测、构建 |
| 产物冒烟 | `scripts/smoke-test.mjs` 检查 10 个导出入口都能被解析 |
| `publint` | 校验 `package.json` 的 exports 映射与类型声明 |
| 示例构建 | 类型检查 + 构建 + 测试示例应用，验证真实使用方可用 |

发布由根目录的 `VERSION` 文件驱动：修改 `VERSION` 并合并到 `main` 后，Release 工作流会打 `v<version>` tag、创建 GitHub Release；配置了 `NPM_TOKEN` secret 时会自动 `npm publish`。提交与文档约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 兼容性

- **浏览器**：支持 ES2022 的现代浏览器（Chrome / Edge、Firefox、Safari 的近期版本）；不提供 IE 与旧版 WebView 支持。
- **Node.js**：`>= 18.17`，仅用于构建与测试。
- **模块格式**：ESM only，构建产物带 `.d.ts` 类型声明。
- **无框架依赖**：不含 React/Vue 代码，可直接用在任意前端框架或原生页面。
- **`localStorage` 不可用时降级**：凭据存储退化为内存实现，刷新即丢失，不会抛错。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | api/scene 分层、装配模型、数据流、扩展指引 |
| [docs/pitfalls.md](docs/pitfalls.md) | 开放平台接口坑位合集（分页、编码、错误码、上传下载等） |
| [docs/proxy.md](docs/proxy.md) | 同源代理完整配置（Vite / Nginx / 静态托管 / 同源部署） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、代码约定、测试与提交规范 |
| [SECURITY.md](SECURITY.md) | 漏洞报告与凭据处理规范 |
| [docs/testing/report.md](docs/testing/report.md) | 各版本的测试命令与执行结果 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方组件与许可证 |

## License

[Apache-2.0](LICENSE)。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 贡献

欢迎提交 issue 与 pull request：

- 提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，commit 消息需符合 Conventional Commits（`feat(scope): subject`）。
- 参与即表示同意遵守 [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
