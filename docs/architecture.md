# 架构说明

## 定位

`baidu-drive-sdk-js` 是浏览器侧的百度网盘 SDK：把开放平台的 HTTP 协议、授权流程和一批高频业务场景（列目录、上传、下载、文件管理、账号信息）封装成可组合的模块。

分层与 [`baidu-drive-sdk-go`](https://github.com/baidu-netdisk/baidu-drive-sdk-go) 一一对应：

- **api 层**（`src/api/`）—— 与开放平台接口一一对应，包含传输、客户端工厂、端点描述、错误码、重试和**授权**
- **scene 层**（`src/scene/`）—— 业务场景编排，只依赖 api 层

设计上有四个取舍：

1. **浏览器优先**：只用标准 Web API（`fetch`、`Blob`、`FormData`、`localStorage`、`crypto`、`window.postMessage`），不依赖 Node 运行时，也不依赖任何 UI 框架。
2. **单包 + 子路径导出**：一个 npm 包、十个入口，可以按层（`/api`、`/scene`）或按场景（`/scene/file-browse` 等）引入。
3. **端点描述与客户端分离**：接口描述是纯数据，可以跨 app、跨账号复用；"用谁的 token"由实例决定。
4. **没有默认实例**：`createOpenApi()` 与 `createScene()` 都必须显式调用，见下文。

## 分层

```text
              ┌──────────────────────────────────────────────────┐
              │  scene 层：业务编排，不做协议                       │
              │  scene/index.ts        createScene()（聚合）       │
              │  scene/file-browse     列目录 / 搜索 / 分类        │
              │  scene/file-manage     存在性 / 建目录 / 文件操作   │
              │  scene/file-upload     单步 / 三步上传             │
              │  scene/file-download   dlink / 读字节 / 触发下载    │
              │  scene/user-info       资料 / 容量                 │
              └──────────────────┬───────────────────────────────┘
                                 │ 只依赖 api
              ┌──────────────────▼───────────────────────────────┐
              │  api 层：协议 + 传输 + 授权                        │
              │  ├── transport.ts   发请求 / 读响应 / 传输错误      │
              │  ├── client.ts      baseUrl + 凭证 + 解析钩子       │
              │  ├── openapi.ts     access_token / errno / defineApi│
              │  ├── endpoints.ts   端点描述（纯数据）              │
              │  ├── errno.ts       errno → 中文文案 / 重授权判定   │
              │  ├── retry.ts       只重试"下次有意义"的错误        │
              │  └── auth/          简化模式授权 + 凭据缓存         │
              └──────────────────┬───────────────────────────────┘
                                 │
              ┌──────────────────▼───────────────────────────────┐
              │  HTTP：fetch + 同源代理                            │
              └──────────────────────────────────────────────────┘
```

依赖方向是单向的，并且**只有这一条**：

- `scene` → 只 import `api`
- `api` → 不 import 任何 `scene` 代码
- `api/auth` → 只用标准 Web API，不 import `api` 的传输层
- 聚合入口 `src/index.ts` 只是 `export * from './api'` + `export * from './scene'`，不改变方向

## 十个导出入口

| 子路径 | 对应源码 | 说明 |
| --- | --- | --- |
| `baidu-drive-sdk-js` | `src/index.ts` | 聚合出口，摊平 api + scene |
| `baidu-drive-sdk-js/api` | `src/api/index.ts` | api 层聚合：传输、客户端、端点、错误码、重试、授权 |
| `baidu-drive-sdk-js/api/auth` | `src/api/auth/index.ts` | 授权与凭据（也可从 `/api` 引入） |
| `baidu-drive-sdk-js/api/auth/vite` | `src/api/auth/vite.mjs` | Vite 插件，产出 OAuth 回调页 |
| `baidu-drive-sdk-js/scene` | `src/scene/index.ts` | scene 层聚合，含 `createScene()` |
| `baidu-drive-sdk-js/scene/file-browse` | `src/scene/file-browse/index.ts` | 文件浏览与搜索 |
| `baidu-drive-sdk-js/scene/file-manage` | `src/scene/file-manage/index.ts` | 文件管理 |
| `baidu-drive-sdk-js/scene/file-upload` | `src/scene/file-upload/index.ts` | 上传 |
| `baidu-drive-sdk-js/scene/file-download` | `src/scene/file-download/index.ts` | 下载 |
| `baidu-drive-sdk-js/scene/user-info` | `src/scene/user-info/index.ts` | 用户资料与容量 |

按层引入可以得到完整的 api 或 scene；按场景引入只打包用到的那一块。两者用的是同一份实现，不存在"聚合层和单场景行为不一致"。

## 为什么 api 层包含授权

Go SDK 的 `baidudriver/api` 里包含 `Auth`（`Code2Token`、`DeviceCode`、`RefreshToken`），本 SDK 对齐这一划分：授权属于"协议能力"，不属于"业务场景"，所以放在 `api/auth` 而不是 `scene`。

这样划分还有两个工程上的好处：

1. **auth 可以独立使用**。`auth` 只依赖标准 Web API，不 import 传输层。`api/auth/index.ts` 用结构类型连接请求层——`auth.tokenStore` 的形状是 `{ get, set, clear }`，正好满足 `api` 的 `TokenStore` 接口，两边没有编译期依赖。
2. **scene 不需要知道 token 从哪来**。scene 拿到的是已经装配好的 `OpenApi`，它只负责编排；换存储、换账号、换 token 来源都不影响 scene。

浏览器侧与 Go 版的差异在授权能力上：Go 跑在服务端，支持授权码、设备码和 `refresh_token`；浏览器不能持有 `client_secret`，所以只做简化模式（implicit），也拿不到 `refresh_token`。

## 为什么没有默认实例

`createOpenApi()` 必须显式调用，`createScene()` 也一样。这不是为了多写几行代码，而是四个具体问题：

**1. 一个页面里可能同时存在多个 app / 多个账号**

一个后台同时管理两个网盘应用，或者用户切换账号，都是真实场景。模块级单例意味着 `tokenStore` 是全局可变状态，后装配的覆盖先装配的——表现是"切了账号之后所有请求还带着旧 token"，而且很难定位。

**2. token 串号是安全问题，不只是 bug**

`auth` 已经把 appKey + 回调地址 + scope 哈希进存储 key，不同 app 的凭据不会互相覆盖。但如果请求层持有全局实例，这份隔离就白做了：请求层永远拿最后一个 token。

**3. SSR 会跨请求串号**

只要将来在 Node 侧做首屏渲染或预热，模块级实例就是进程级共享状态：A 用户的请求可能带着 B 用户的 token 发出去。显式装配至少保证"每个请求一份"是可能的。

**4. 测试需要注入假端点**

场景工厂的构造签名接受 `OpenApi | Partial<Deps>`。单测里传假端点，不需要伪造浏览器、不需要拦 `fetch`、更不会打到真实接口：

```ts
const browse = createFileBrowse({
  listFiles: async () => ({ errno: 0, guid_info: '', list: [] })
});
```

如果构造时读全局单例，这个能力就不存在了。

## createScene 的装配模型

`createScene` 是 scene 层的聚合入口，对应 Go 的 `sc := scene.New(client)`。

```ts
export interface SceneConfig {
  api: OpenApi;                                   // 主接口，通常 baseUrl '/pan'
  transfer?: OpenApi;                             // 上传/下载域名，通常 baseUrl '/pcs'
  proxyPrefix?: string;                           // 下载同源地址前缀，默认 '/pcs'
  computeMd5?: (blob: Blob) => Promise<string>;   // 覆盖分片 MD5 实现
}

export function createScene(config: SceneConfig | OpenApi): Scene;
```

行为细节：

- 传裸 `OpenApi` 等价于 `{ api }`：`'defineApi' in config` 用来区分两种入参。
- 不传 `transfer` 时，读场景（列表、搜索、用户信息、下载地址）正常可用；**`upload` 返回一个 reject 的 Promise，错误是 `ConfigError`**，不会同步抛。这样调用方的 `try/await` 都能接到。
- `Scene` 是五个场景接口的交叉类型（`FileBrowse & FileManage & FileUpload & FileDownload & UserInfo`），各场景方法名当前没有冲突，所以可以安全摊平到同一个对象上。
- 需要更细的依赖边界（比如只要浏览能力、不想打包上传）时，不走 `createScene`，直接 `createFileBrowse(api)` 即可。

```ts
// 推荐：一个实例调完所有事
const sc = createScene({ api, transfer });
await sc.listDir('/');
await sc.upload(file, '/apps/myapp/a.txt');

// 精细控制：只装配用到的场景
const browse = createFileBrowse(api);
await browse.listDir('/');
```

## 数据流

```text
  用户点击「授权」
        │
        ▼
  auth.authorize() ──────► 有可用缓存？── 是 ──► 直接返回 Credential
        │                          │
        │ 否                        │
        ▼                          │
  beginOauth() 生成 state + 授权 URL│
        │                          │
        ▼                          │
  window.open(授权页)               │
        │                          │
        ▼                          │
  回调页（由 api/auth/vite 产出）    │
   ├─ postMessage 给 opener         │
   └─ 写 localStorage[state]        │
        │                          │
        ▼                          ▼
  waitOauth() 校验 state / 来源，保存 Credential
        │
        ▼
  auth.tokenStore.get()  ──►  createOpenApi({ tokenStore })
                                     │
                                     │ 每次请求时读取 token
                                     ▼
                              createScene({ api, transfer })
                                     │  把端点 bind 到实例
                                     ▼
                              sc.listDir('/')
                                     │
                                     ▼
                              client.request(path, options)
                                     │  ① 注入 access_token
                                     │  ② 解析响应（request_id 转字符串）
                                     │  ③ errno 校验 → ApiError
                                     ▼
                              fetch(baseUrl + path)  ──►  同源代理  ──►  开放平台
```

关键点：

- `createOpenApi()` 不在构造时快照 token，而是每次请求调用 `tokenStore.get()`。所以授权完成、token 过期、`logout()` 都能立刻生效，不需要重建实例。
- `tokenStore.get()` 在凭据过期或 scope 不足时返回空串，请求层据此抛 `ConfigError`，避免拿废 token 打接口（那样会得到 `-6` 之类的错误码，还得再翻译一次）。
- `createScene()` 构造时只是把端点 bind 到 api 实例上，不发任何请求。

### 两个 base

上传链路横跨两个域名，所以需要两个 `OpenApi` 实例，共享同一个 `tokenStore`：

```ts
const api = createOpenApi({ tokenStore: auth.tokenStore });                    // /pan  → pan.baidu.com
const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' }); // /pcs → d.pcs.baidu.com

const sc = createScene({ api, transfer });
```

`baseUrl` 只接受同源前缀（`/pan`、`/pcs`）或空串（同源部署）。浏览器直连 `https://pan.baidu.com` 会被 CORS 拦掉，这一点在 [同源代理配置](./proxy.md) 里有完整说明。

## 错误模型

```text
Error
├── ConfigError        配置/装配问题：没 token、缺 transfer 实例（SDK 自己抛）
├── HttpError          传输层：network / timeout / abort / http / parse
│   └── body           非 2xx 时的响应体，业务码在 body.error_code
├── ApiError           业务层：HTTP 200 但 errno !== 0
│   ├── errno          业务错误码
│   ├── errmsg         接口原文
│   └── requestId      字符串，避免大整数精度丢失
├── FileOperationError 单条文件操作失败（顶层 errno 可能是 0）
├── UploadError        上传失败，带 stage：precreate / slice / create / single
└── DownloadError      取不到 dlink 或下载失败
```

分层让调用方能分流处理：

- `ConfigError` → 引导重新授权（不是网络问题，重试没用）
- `ApiError` + `needsReauth(errno)` → 同上
- `HttpError.kind === 'parse'` → 大概率代理配错，返回了 HTML
- `HttpError.kind === 'network' | 'timeout'` → 可以重试
- `FileOperationError` → 批量操作里的单条失败，需要展示具体路径

业务错误码有两个载体（`ApiError.errno` 和 `HttpError.body.error_code`），所以判断错误码统一用 `apiErrno(error)`，不要自己读字段。

## 扩展指引

### 新增一个端点

端点描述**只放在 `src/api/endpoints.ts`**，不要写进 scene 包——端点会跨场景共享（`FILE_METAS` 浏览和下载都要用），写在 scene 包里会出现多份。

步骤：

1. 照抄接口文档的「请求结构 / 请求参数 / 响应参数」三张表，写接口类型
2. 用 `describeApi` 声明描述：

```ts
export interface SomeParams {
  foo: string;
  bar?: number;
}

export interface SomeResult {
  errno: number;
  list: PanFile[];
}

export const SOME_API = describeApi<SomeParams, SomeResult>({
  method: 'POST',                       // 默认 GET
  path: '/rest/2.0/xpan/file',
  fixedQuery: { method: 'some' },       // 文档里固定不变的查询参数
  paramsIn: 'query'                     // 默认 GET→query、POST→form；上传类接口要显式写 query
});
```

3. 注释里留官方文档链接，写清实测到的反直觉行为
4. 从 `src/api/endpoints.ts` 导出，scene 用 `defineApi(SOME_API)` 绑定

### 新增一个 scene 方法

scene 方法的职责是"把多个端点串成用户心里的一件事"，通常做四件事：

1. 补默认参数（例如 `limit` 必须配 `start`、`quota` 必须传 `checkfree=1`）
2. 解码 / 派生（文件名解码、`available = total - used`、逐条 `errno` 翻译）
3. `withRetry` 包住瞬时错误
4. 把结果整理成可直接渲染的形状

```ts
async function someFeature(path: string, options: Options = {}): Promise<Result> {
  const raw = await withRetry(
    () => api.someApi({ path, limit: options.limit ?? 100, start: options.start ?? 0 }),
    options.retry
  );
  return transform(raw);
}
```

新增时同步做三件事：加测试（假端点）、在 README 的「Scene 方法一览」里补充、如果踩到了新的平台坑就写进 [pitfalls.md](./pitfalls.md)。

### 新增一个 scene 包

只有当一组能力在语义上独立、且依赖的端点不与其他包高度重合时才值得新建包。新包的形状固定：

```ts
export interface XxxDeps { /* 用到的端点函数 */ }

export function createXxx(source: OpenApi | Partial<XxxDeps>): Xxx {
  const api: XxxDeps = 'defineApi' in source
    ? { someApi: source.defineApi(SOME_API) }
    : { someApi: source.someApi ?? (() => { throw new Error('缺少端点实现：someApi'); }) };
  // ...
}
```

`'defineApi' in source` 让同一个构造函数既能接 `OpenApi` 实例、也能接假端点对象；缺端点时返回一个"被调用才抛"的函数，而不是在构造时炸掉——这样单测只传部分假端点也能跑起来，调到没传的那个才会暴露疏漏。

新增包还要接到 `src/scene/index.ts`：导入工厂、在 `Scene` 接口里 `extends` 它的接口、在 `createScene()` 的返回对象里展开。扩展前先确认方法名不与现有场景冲突（当前五个包的方法名两两不重名，这是能安全摊平的前提）。

## 测试策略

单元测试统一用假端点，**绝不打真实接口**：

```ts
const browse = createFileBrowse({
  listFiles: async () => ({
    errno: 0,
    guid_info: '',
    list: [{ fs_id: 1, path: '/apps/x/a.txt', server_filename: 'a.txt', size: 1, isdir: 0, category: 1, server_mtime: 0 }]
  })
});
```

对 `fetch` 本身打桩（`vi.stubGlobal('fetch', ...)`）而不是 mock 整个模块，能顺带覆盖到传输层的行为。`auth` 的用例需要 `window` / `localStorage` / `postMessage`，在文件头用 `// @vitest-environment happy-dom` 单独切换。

真实接口的验证与单测分开做，验证纪律见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 目录结构

```text
src/
├── index.ts                 聚合出口（api + scene）
├── api/
│   ├── transport.ts         传输层
│   ├── client.ts            客户端工厂
│   ├── openapi.ts           开放平台适配 + defineApi
│   ├── endpoints.ts         端点描述（唯一允许写端点的地方）
│   ├── errno.ts             errno 文案 / 是否需重新授权
│   ├── retry.ts             重试
│   ├── auth/
│   │   ├── oauth.ts         授权流程
│   │   ├── credential.ts    凭据缓存
│   │   ├── vite.mjs         Vite 插件（手写 JS，见文件头说明）
│   │   ├── vite.d.mts       插件类型声明
│   │   └── index.ts         子路径出口
│   └── index.ts             api 层出口
└── scene/
    ├── index.ts             createScene() + 场景出口
    ├── file-browse/index.ts
    ├── file-manage/index.ts
    ├── file-upload/index.ts
    ├── file-download/index.ts
    └── user-info/index.ts
```

`api/auth/vite` 刻意写成 `.mjs` + 手写 `.d.mts`：它会被 app 的 `vite.config.ts` 引用，而 Vite 加载配置时把 `node_modules` 里的依赖交给 Node，Node 加载不了裸 `.ts`（`ERR_UNKNOWN_FILE_EXTENSION`）。代价是它不走 tsup，由 `scripts/copy-static.mjs` 原样拷进 `dist/api/auth/`。
