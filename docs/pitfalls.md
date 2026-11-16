# 接口坑位合集

这份文档记录百度网盘开放平台在实际使用中与文档描述不一致、或者文档没有写清楚的地方。所有结论都来自真实接口调用（浏览器环境 + 同源代理），代码示例对应本 SDK 的公开 API。

分节方式按"你正在写什么功能"来组织：

1. [错误码与状态码](#1-错误码与状态码)
2. [分页与列表](#2-分页与列表)
3. [路径、文件与文件管理](#3-路径文件与文件管理)
4. [上传](#4-上传)
5. [下载](#5-下载)
6. [账号与容量](#6-账号与容量)
7. [代理与装配](#7-代理与装配)

> 约定：文中"实测"指在真实账号 + 真实 token 下观察到的行为；"文档"指开放平台公开的接口文档。两者冲突时，**以实测为准，但功能上线前建议再自己验一次**——平台行为会变。

---

## 1. 错误码与状态码

### 1.1 业务错误在 HTTP 200 里

开放平台失败时同样返回 HTTP 200，真正的结果在响应体的 `errno` 上。所以**不能只看 `response.ok`**。

本 SDK 在 `createOpenApi()` 装配的 client 上挂了 `validate: assertOpenApiOk`：`errno !== 0` 时抛 `ApiError`。拿到 `ApiError` 说明请求发出去了、平台也回了，是业务失败。

```ts
import { ApiError } from 'baidu-drive-sdk-js/api';

try {
  await browse.listDir('/apps/your-app-name');
} catch (error) {
  if (error instanceof ApiError) {
    console.log(error.errno, error.message, error.errmsg, error.requestId);
  }
}
```

`ApiError.message` 是 SDK 内置的中文说明（来自 `errnoMessage`），`errmsg` 是接口原文（经常是 `Invalid Bduss` 这类没法直接给用户看的内容），两个都保留，排查时对得上平台日志。

### 1.2 非 2xx 时业务码在 `body.error_code` 里

不是所有失败都走 HTTP 200。实测这几类都是非 2xx，业务码藏在响应体：

| 场景 | HTTP | 业务码字段 |
| --- | --- | --- |
| `method=meta` 查不存在的路径 | 404 | `error_code: 31066` |
| `method=meta` 查目录 | 400 | `error_code: 31301` |
| 上传重名 | 400 | `error_code: 31061` |
| 分片大小不对 | 400 | `error_code: 31299` |
| 上传路径越权 | 403 | `error_code: 31064` |

这时 SDK 抛的是 `HttpError`，`error.errno` 不存在。**统一用 `apiErrno(error)` 取业务码**，它同时看 `ApiError.errno` 和 `HttpError.body.error_code`：

```ts
import { isErrno } from 'baidu-drive-sdk-js/api';

try {
  await manage.exists('/apps/your-app-name/a.txt');
} catch (error) {
  // 31066 没有对应常量，直接按数值判断
  if (isErrno(error, 31066)) { /* 文件不存在 */ }
}
```

自己读 `error.errno` 一定漏判——非 2xx 时它根本不存在，这是接入时最常见的 bug。需要按码分流时用 `isErrno(error, Errno.PathNotExist)` 这类写法。

### 1.3 `request_id` 超出 JS 安全整数范围

`request_id` 是 18~19 位整数，直接 `JSON.parse` 会丢末位，排查时和平台日志对不上。SDK 在解析前把 `request_id` 改写成字符串（只改整数形式，不动 `7.79e+16` 这种科学计数法），所以 `ApiError.requestId` 是 `string`，原样贴给平台即可。

### 1.4 `filemanager` 顶层 `errno` 为 0 不代表成功

复制/移动/重命名/删除返回 `info[]`，每一条带自己的 `errno`。顶层 `errno: 0` 只说明请求被受理了，批量操作里部分失败很常见。

```ts
// 自己绑定端点时必须自己校验 info[]
import { DELETE_FILES } from 'baidu-drive-sdk-js/api';

const deleteFiles = api.defineApi(DELETE_FILES);
const result = await deleteFiles({ async: 1, filelist: paths });

// ❌ 批量删除里有一条失败会被当成全部成功
if (result.errno === 0) console.log('删完了');
```

`scene/file-manage` 已经把逐条失败翻成 `FileOperationError`（带 `path` 和 `errno`）。绕过 scene 层直接调端点时，必须自己遍历 `info`：

```ts
const failed = (result.info ?? []).filter((item) => item.errno !== 0);
if (failed.length > 0) throw new Error(`部分失败：${failed[0].path}`);
```

同样的"逐条 errno"也出现在 `filemetas` 的 `list[]` 上，见 [5.6](#56-filemetas-的逐条-errno)。

### 1.5 可重试与不可重试

`withRetry` 默认重试 3 次、退避 300ms → 600ms。白名单是：

- `errno 31034`：命中接口频控
- `errno 111`：有其他异步任务正在执行
- `HttpError` 的 `network` / `timeout`
- `HttpError` 的 5xx

**不要**把 `-6`（token 失效）、`-9`（路径不存在）加进白名单：前者重试多少次都得重新授权，后者是路径真的不存在，重试只是浪费配额。

```ts
const files = await browse.listDir('/apps/your-app-name', {
  retry: { attempts: 5, baseDelayMs: 500 }
});
```

需要重新授权的错误码可以用现成的判断：

```ts
import { needsReauth } from 'baidu-drive-sdk-js/api';

if (error instanceof ApiError && needsReauth(error.errno)) {
  auth.logout();
  await auth.authorize();
}
```

`needsReauth` 覆盖 `-6`、`20016`、`20017`、`31045`。**简化模式没有 refresh_token，过期只能重新授权，不能静默续期。**

---

## 2. 分页与列表

### 2.1 三套分页模型，别混

| 接口 | scene 方法 | 分页参数 | 翻页方式 | 结果字段 |
| --- | --- | --- | --- | --- |
| `method=list` | `listDir` / `listAll` | `start` + `limit` | 自己累加 `start` | `list` |
| `method=listall` | `listTree` | `start` + `limit`（上限 10000） | **用响应里的 `cursor`** 当下一次的 `start` | `list` |
| `method=imagelist` 等 | `images` / `videos` / `docs` / `torrents` | `page` + `num` | 页码从 1 开始 | **`info`** |

`listAll` 和 `listTree` 名字相近但做的事不同：

- `listAll(dir)`：把这**一个目录**翻页翻完（底层 `method=list`，自己累加 `start`；默认最多 50 页，超过会抛 `BrowseTruncatedError`，可用 `maxPages` 放宽）
- `listTree(dir)`：连**子目录**一起列（底层 `method=listall`，平台递归；同样有 50 页上限并会抛错）

统计一个目录占多少空间用 `listTree`，渲染一层文件列表用 `listAll`。

`listall` 的 `cursor` 缺失时必须停下——继续用旧 `start` 会无限拉同一页。scene 层已经处理了这个分支。

**分页截断不再静默**：`listAll` / `listTree` 达到翻页上限时会抛 `BrowseTruncatedError`（带 `dir` / `pages` / `count`），不会再悄悄返回半份数据。

**`limit` 超过平台上限时不会误判结束**：`listAll` 会把页大小夹到 1000 再翻页，否则传 `limit: 2000` 时平台按 1000 返回，会被当成「最后一页」。

媒体列表那一族还有个额外差异：**不传 `page` 是不分页模式，一次返回全部**，结果在 `info` 而不是 `list`。

### 2.2 `limit` 单独传会被忽略

文档把 `start` 和 `limit` 都标成可选、各有默认值，照文档写必踩：

| 请求 | 实测返回 |
| --- | --- |
| `limit=10` | 1000 条 |
| `start=0&limit=10` | 10 条 |

`listDir` 已经自动补 `start: 0`，所以**不要绕过 scene 层直接调 `listFiles`**：

```ts
// ✅ start 会自动补
const page = await browse.listDir('/apps/your-app-name', { limit: 10 });

// ❌ 直接调端点时漏了 start，limit 被忽略
const raw = await api.defineApi(LIST_FILES)({ dir: '/apps/your-app-name', limit: 10 });
```

### 2.3 搜索的关键字参数是 `key`，不是 `query`

`method=search` 用 `key`。另外文档写明 `num` 默认 500 且不可修改，**搜索结果总量不受调用方控制**，用 `hasMore` 判断有没有被截断：

```ts
const { files, hasMore } = await browse.search('合同', { category: 4, dir: '/apps/your-app-name' });
if (hasMore) console.log('结果被截断了，缩小搜索范围或加 category');
```

`search` 默认递归整个目录树（`recursion=1`），只要当前目录时传 `{ recursive: false }`。

### 2.4 语义搜索可能"成功但零结果"

`searchSemantic` 走 `POST /xpan/unisearch`。实测返回 `errno 0` + 空列表，无法区分"应用没有语义搜索权限"和"查询确实没命中"——两种情况响应完全一样。

- 接口是调得通的，`paramsIn` 固定在查询串里、请求体固定 `{}`
- 上线前请拿一个**确定能命中的查询**再验一次，不要只看"没报错"

### 2.5 分类统计可能一直返回 `errno 31034`

`categoryStats`（`/api/categoryinfo`）在部分应用上实测连续 6 次都返回 `errno 31034`，文案是"命中接口频控"，间隔 5 秒重试也一样。持续失败说明多半不是真的频控，而是这个接口没对该应用开放，平台用了一个误导性的错误码。

方法保留着，但**别假定它可用**；真要用先去控制台确认权限。`31034` 在重试白名单里，所以你会看到它重试三次后才抛错。

---

## 3. 路径、文件与文件管理

### 3.1 文件名和路径是 URL 编码的

`list` / `search` / `listall` 返回的 `server_filename` 和 `path` 都是编码过的，直接渲染就是一串 `%E5%B7%A5%E5%85%B7`。

```ts
const files = await browse.listDir('/apps/your-app-name');
files.forEach((f) => {
  console.log(f.name);         // ✅ 解码后的文件名
  console.log(f.decodedPath);  // ✅ 解码后的绝对路径
  console.log(f.server_filename); // ❌ 原始编码值
});
```

scene 层的解码失败时会退回原值——不能让一个坏名字把整次列目录搞崩。自己调端点时记得 `decodeURIComponent`，并且 `try/catch`。

**只看文件夹（`folder=1`）时平台只返回 `path`、不返回 `server_filename`**。直接解码会得到字符串 `"undefined"`；scene 层已用路径最后一段兜底，自己调端点时要留意。

### 3.2 应用只能访问自己的 `/apps/<应用名>`

应用 token 有目录边界：只能读写自己的 `/apps/<应用名>`。访问别处返回 `errno 20020`（路径不在允许的访问范围内）。

但这条边界比想象中宽松：

- `method=list` **可以列根目录**，也能列到 `/apps` 本身
- `filemanager` 的 `copy` **能把应用目录外的文件复制进来**

所以"查不到 ≠ 操作不了"。`scene/file-manage` 的前置检查因此设计成"查不动就放行，交给平台判"，不要改成遇错即拦——那会把平台允许的操作误判成失败。

### 3.3 三种 `filelist` 结构不一样

`filemanager` 的 `filelist` 是 JSON 数组，结构随 `opera` 变化，这是最容易写错的地方：

| `opera` | `filelist` 元素 |
| --- | --- |
| `copy` / `move` | `{ path, dest, newname }` |
| `rename` | `{ path, newname }` |
| `delete` | 路径字符串（`string[]`，**不是对象**） |

`opera` 在**查询串**里，`async` / `filelist` / `ondup` 在**表单体**里。所以端点被拆成 `COPY_FILES` / `MOVE_FILES` / `RENAME_FILES` / `DELETE_FILES` 四个描述，而不是一个描述加参数。

`rename` 不要用 `move` 实现（`dest` + `newname` 的语义和单纯改名不同），直接调 `manage.rename(path, newName)`。

### 3.4 `meta` 只能查文件，不能查目录

`method=meta` 只接受 stream file（普通文件）：

| 路径状态 | 实测响应 |
| --- | --- |
| 文件存在 | HTTP 200 + `errno 0` |
| 文件不存在 | **HTTP 404** + `error_code 31066` |
| 路径是目录 | **HTTP 400** + `error_code 31301`（not stream file） |
| 路径越权 | HTTP 200 + `errno 20020` |

`scene/file-manage` 的 `exists()` 已经处理好这三种分支：`31066` / `-9` 返回 `false`，`31301` 返回 `true`（语义是"存在但不是文件"），其余照常抛出。

**`mkdirIfNotExist` 判断目录存在性时优先用 `list`**（`start=0&limit=1`），因为用 `meta` 探测目录固定产生一条 HTTP 400，虽然 catch 得住，但会在浏览器网络面板里留下误导性的红字。

### 3.5 两种"不存在"的表达

同一个"路径不存在"，平台有两种回法：

- `errno -9`（文件或目录不存在，HTTP 200）
- `error_code 31066`（HTTP 404）

实测 `method=meta` 走的是后者。所以判断存在性必须用 `apiErrno(error)` 同时覆盖两个码：

```ts
const NOT_FOUND = new Set([-9, 31066]);
const errno = apiErrno(error);
if (NOT_FOUND.has(errno)) return false;
```

### 3.6 删除没有回收站语义保证

`remove` 不保证可恢复。验证或调试时优先用可恢复的操作（`mkdirIfNotExist` + `copy` + `rename`），删除放最后，并且只删自己刚创建的路径。

---

## 4. 上传

### 4.1 上传链路全程没有 CORS 响应头

`precreate`、`superfile2`、单步上传的响应都不带 `Access-Control-Allow-Origin`，浏览器直连一个都不行。必须经同源代理，和主接口的 `/pan` 是同样的处理方式（`/pcs` 前缀）。

### 4.2 分片固定 4MB，不能调小

平台按固定 4MB 切分，`block_list` 的分片边界必须和它一致。实测把分片改成 256 字节后，`superfile2` 直接返回 HTTP 400 + `error_code 31299`（第一个分片大小不足 4MB）。

`createFileUpload({ sliceSize })` 这个配置项留着只为平台改规则时有地方改。**不要拿它来做"用小文件验证多分片链路"**——验多分片就得传一个真的超过 4MB 的文件（内存里生成即可）。

```ts
import { SLICE_SIZE } from 'baidu-drive-sdk-js/scene/file-upload';
console.log(SLICE_SIZE); // 4194304
```

### 4.3 `create` 的 `block_list` 要用云端返回的 MD5

三步流程里有两份"分片 MD5"：

1. 本地算的：`precreate` 的 `block_list` 用这份
2. **云端算的**：`superfile2` 返回的 `md5` 字段，`create` 的 `block_list` 必须用这份

scene 层已经按分片序号把云端的值覆盖进 `remoteMd5s`，不要图省事直接把本地那份传进 `create`：

```ts
// 伪代码，示意两处 block_list 的来源不同
const localMd5s = await Promise.all(slices.map(md5OfBlob));
const pre = await precreate({ path, size, isdir: 0, autoinit: 1, block_list: localMd5s });
const remoteMd5s = [...localMd5s];
for (const index of pre.block_list ?? []) {
  const { md5 } = await superfile2({ path, uploadid: pre.uploadid, partseq: index }, { multipart: { file: slices[index] } });
  remoteMd5s[index] = md5;
}
await uploadCreate({ path, size, isdir: 0, uploadid: pre.uploadid, block_list: remoteMd5s });
```

浏览器没有 MD5：`crypto.subtle` 只有 SHA 家族，所以需要 `spark-md5`（SDK 已内置，也可以传 `computeMd5` 换实现）。

### 4.4 单步上传返回的 `md5` 不是合法 hex

实测拿到过 `be7911c5co1fffe7913231dcbee94bfb`——第 10 位是字母 `o`。**不要用单步上传的 `md5` 做完整性校验**，它可能根本不是十六进制。

分片上传返回的 `md5` 是正常的，而且和本地算的一致，可以用于校验。要验证上传内容没被改坏，走"分片上传 + 下载回来比 MD5"的闭环。

### 4.5 `ondup` 和 `rtype` 是同一件事的两套命名

| 流程 | 参数 | 取值 |
| --- | --- | --- |
| 单步上传 | `ondup` | `fail` / `overwrite` / `newcopy` |
| 三步分片（precreate / create） | `rtype` | `0` 重名失败 / `1` 重名重命名 / `2` 冲突且 block_list 不同才重命名 / `3` 覆盖 |

`createFileUpload` 对外只暴露 `ondup`，内部翻译成 `rtype`。自己拼三步流程时别忘了这层映射。

### 4.6 `superfile2` 和单步上传的参数在查询串里

这两个接口是 `POST`，但业务参数（`path` / `uploadid` / `partseq`）在查询串，请求体留给文件内容（`multipart/form-data`）。所以端点描述显式写了 `paramsIn: 'query'`。

漏掉这个配置的话，`defineApi` 会按 POST 的默认行为把参数塞进表单体，和 `file` 字段打架。自己新增上传类端点时，先想清楚 `paramsIn` 该是 `'query'` 还是 `'form'`。

### 4.7 上传域名可以固定用 `d.pcs.baidu.com`

文档建议调 `locateupload` 动态取域名、不要硬编码，但：

- `locateupload` 要求先有 `uploadid`
- 浏览器侧的代理规则是静态的，撑不住动态域名（实测它返回的是 `c.pcs.baidu.com` 这类随机节点）

实测固定打 `d.pcs.baidu.com` 的 `superfile2` 和单步上传都成功。代价是放弃就近节点的速度优化；极在意传输速度时可以在自己的服务端按文档走 `locateupload`。

### 4.8 单步上传在部分应用上下文里会被拒

实测在 `/apps/<应用名>/...` 路径上用单步上传收到过 HTTP 403 + `error_code 31064`（提示 `file is not authorized`），与这个码的通用文案"上传路径错误，必须在 `/apps/<应用名>` 下"并不完全对应。

遇到这个现象就强制走三步流程，三步是可用的：

```ts
await uploader.upload(file, `${APP_DIR}/${file.name}`, {
  ondup: 'overwrite',
  forceSlice: true,   // 小文件也走 precreate → superfile2 → create
  onProgress: ({ ratio }) => setPercent(Math.round(ratio * 100))
});
```

排查 403 时先用 `precreate` 探一下权限：它能通，说明应用有上传权限，问题只在单步上传这条路上。

### 4.9 秒传分支只有单测覆盖

`precreate` 返回 `return_type === 2` 表示云端已有这份内容、可以直接结束。代码按这个语义处理了（返回 `via: 'rapid'`），但实测用同样内容重复 `precreate` 拿到的仍是 `return_type: 1`。

所以**秒传的真实命中条件未知**——可能需要额外带 `content-md5` / `slice-md5`。不要依赖 `via === 'rapid'` 做业务判断，也不要假定上传一定产生了网络流量。

### 4.10 单文件上限取决于会员等级

普通用户 4GB、会员 10GB、超级会员 20GB。SDK 按 20GB 做上界校验，超了直接抛 `UploadError` 不发请求。分片数量 = 文件大小 / 4MB，20GB 就是 5120 片，注意进度回调与取消的处理。

### 4.11 分片 MD5 要串行算，别并发读整份文件

三步上传要先算出每个 4MB 分片的 MD5 作为 `block_list`。如果用 `Promise.all` 一次并发算全部，同一时刻所有分片都被读进内存——内存峰值约等于文件本身大小，20GB 文件必然把标签页撑爆。

SDK 现在是**串行**逐片计算：同一时刻只持有一片（几 MB），代价是计算阶段稍慢。需要自定义实现时（`computeMd5` 选项）也请保持串行或小并发。

### 4.12 `precreate` 的 `block_list` 空数组等价于「传第 0 片」

平台文档写明：响应里的 `block_list` 为空数组等价于 `[0]`，不是「没有分片要传」。把它当成空清单会跳过全部分片直接 `create`，结果是上传失败（或内容残缺）。SDK 已按 `[0]` 处理；自己实现三步流程时注意区分「字段缺失」与「空数组」。

---

## 5. 下载

### 5.1 真正的限制是 CORS，不是 User-Agent

文档把 `User-Agent: pan.baidu.com` 写成必填，还说 `31326` 防盗链就是查它。实测**不是**：用浏览器 UA（甚至带上 `Origin` 头）请求 dlink 都正常返回 206 和文件字节。

被推翻的结论：浏览器下载不了。真正拦住的是 CORS——dlink 的响应没有 `Access-Control-Allow-Origin`（带不带 `Origin` 头都没有）。

### 5.2 两种"下载"的限制完全不同

| 要做的事 | 用哪个 | 走什么 | 需要代理吗 |
| --- | --- | --- | --- |
| 用户点一下，文件存到本地 | `saveAs` / `downloadUrl` | 浏览器**导航** | 不需要 |
| 预览图片、播视频 | `downloadUrl` 贴到 `src` | 资源加载 | 不需要 |
| 把字节读进 JS（校验、解析、canvas） | `fetchBlob` / `sameOriginUrl` | `fetch` | **需要** |

导航和资源加载不受同源策略约束；`fetch` 受。所以：

- `fetch(dlink)` 会被浏览器拦 → 必须经同源代理
- `<a href=dlink download>` / `window.location = dlink` 是导航 → 直接可用
- `<img src>` / `<video src>` 是资源加载 → 直接可用（但往 canvas 读像素会被污染）

```ts
import { download } from './pan';

// 存到本地：不需要代理
await download.saveAs(fsId);

// 预览：直接贴 dlink
img.src = await download.downloadUrl(fsId);

// 读字节：走 /pcs 代理
const blob = await download.fetchBlob(fsId);
```

### 5.3 dlink 会 302 到随机 CDN 节点

`dlink` 在 `d.pcs.baidu.com` 上，实测返回 **302**，跳到 `ndN.baidupcs.com` 这类随机 CDN 节点。这带来的后果是：

- 浏览器经代理拿到 302 后如果自己跟随，就跨域到 CDN（CDN 没有 CORS 头）→ 读不到字节
- 所以**代理必须由服务端跟随 302**：Vite 用 `followRedirects: true`，生产用会 `redirect: 'follow'` 的函数/网关，再同源回传字节

只配 rewrite 不跟随跳转，`fetchBlob` 会失败或者拿到 302 的空响应。

### 5.4 `download` 属性对跨域地址无效

`saveAs(fsId, filename)` 的 `filename` 在跨域 dlink 上会被浏览器忽略，文件名由服务端响应头决定。想完全控制文件名，得走 `fetchBlob` 拿 `Blob` + `URL.createObjectURL` 自己触发下载——但那是"管下载 UI"的职责，SDK 没做。

`saveAs` 需要 DOM，Node 环境会抛 `DownloadError`，请在浏览器里用。

### 5.5 dlink 带着 `access_token`

`dlink` 上拼了 `access_token`，它会出现在 DOM 的 `href` / `src` 里。**不要写进日志、存进数据库或贴到公开页面**，那等于把凭据发出去。需要长期可用的地址就每次重新取——dlink 本身也有有效期。

`scene/file-download` 在内部生成的锚点上加了 `rel="noreferrer"`，减少地址通过 Referer 外泄。

### 5.6 `filemetas` 的逐条 errno

`filemetas` 顶层 `errno` 为 0 时，`list[].errno` 仍可能非 0（比如 `-9` 文件不存在）。`scene/file-download` 已经把这种逐条失败翻成 `DownloadError`，不会让你拿到一个没有 `dlink` 的对象。

自己调端点时要判：

```ts
const first = (result.list ?? [])[0];
if (first === undefined) throw new Error('没有查到这个 fsid 的文件');
if (first.errno !== undefined && first.errno !== 0) throw new Error(`errno ${first.errno}`);
```

另外 `filemetas` **只认 `fsid`，不认路径**。路径转 fsid 要先过 `scene/file-browse`。

---

## 6. 账号与容量

### 6.1 `netdisk_name` 可能是空串

实测部分账号的 `uinfo` 返回 `netdisk_name: ""`，而 `baidu_name` 有值。文档把两个字段平铺着写、没提这种情况，照"展示用网盘账号名"实现就是一个空白用户名。

渲染一律用 `displayName`，回退顺序是 `netdiskName` → `baiduName` → `用户 <uk>`：

```ts
const { profile } = await user.overview();
console.log(profile.displayName);  // ✅ 永远是可用文本
console.log(profile.netdiskName);  // ❌ 可能是空串
```

### 6.2 `free` 不是剩余空间

`/api/quota` 的 `free` 是**免费容量**，不是剩余可用空间。剩余可用要自己算 `total - used`：

| 字段 | 含义 |
| --- | --- |
| `total` | 总空间 |
| `used` | 已用空间 |
| `available` | **剩余可用** = `total - used`，接口不给，SDK 算的 |
| `free` | **免费容量**，接口原字段 |
| `usedRatio` | 已用占比 0~1 |
| `expiring` | 7 天内是否有容量到期 |

拿 `free` 当可用量显示是这组接口最容易犯的错——实测同一个账号下，`free` 只有几 GB，而 `available` 有几十 TB，差了四个数量级。

### 6.3 `checkfree` / `checkexpire` 默认是 0

不传这两个参数，响应里就没有 `free` 和 `expire` 字段。`scene/user-info` 的 `quota()` 固定传 `checkfree=1&checkexpire=1`，所以不要绕过 scene 层直接调 `QUOTA` 端点。

### 6.4 `vip_type` 的含义取决于 `vip_version`

| `vip_version` | `vip_type` 含义 |
| --- | --- |
| 不传（默认） | `0` 普通用户 / `1` 普通会员 / `2` 超级会员 |
| `v2` | VIP / SVIP 的新叫法 |

SDK 不传该参数，`vipLabel` 按旧含义翻译（`普通用户` / `普通会员` / `超级会员`）。要切 v2，得同时改端点参数和这张映射表，否则文案会错位。

### 6.5 `total` 可能是 0

容量接口的 `total` 可能是 0（新号、异常账号）。占比要除以它，没防住就是 `NaN` 渲染到页面上。`usedRatio` 在 `total === 0` 时返回 0，`available` 也做了非负截断。

---

## 7. 代理与装配

### 7.1 `/api/quota` 和 `/api/categoryinfo` 不在 `/rest/2.0/xpan` 下

这两个异类最容易在配代理时漏掉：

| 端点 | 路径 | 备注 |
| --- | --- | --- |
| 容量 | `/api/quota` | 没有 `method` 查询参数 |
| 分类统计 | `/api/categoryinfo` | 同上 |

所以代理规则要**按前缀整体转发**（`/pan/(.*)` → `pan.baidu.com/$1`），不要在网关里逐条枚举接口路径——枚举一定会漏，而且新增端点时要改网关。完整配置（Vite / Nginx / 静态托管 / 同源部署）见 [同源代理配置](./proxy.md)。

### 7.2 代理配错会表现成"成功但数据为空"

静态托管的 SPA 兜底会用 HTTP 200 返回 `index.html`。如果代理没命中、请求被兜底吃掉，响应就是 HTML 而不是 JSON。

SDK 在 2xx 分支强制解析 JSON，解析失败抛 `HttpError`（`kind: 'parse'`，message 里带响应片段），**不会让你拿到 `null` 然后静默失败**。看到 `kind: 'parse'` 就去查代理规则，排查顺序见 [同源代理配置](./proxy.md) 的「验证」一节。

```ts
if (error instanceof HttpError && error.kind === 'parse') {
  console.error('大概率是代理没命中，返回了 index.html');
}
```

### 7.3 传数组参数会自动 JSON 序列化

`fsids`、`filelist`、`block_list`、`target` 这些接口参数要求 JSON 字符串。`toSearchParams` 会把数组和对象自动 `JSON.stringify`，所以直接传数组即可：

```ts
await api.defineApi(FILE_METAS)({ fsids: [123, 456], dlink: 1 });
// 实际查询串：fsids=%5B123%2C456%5D&dlink=1&access_token=...
```

同时注意它**只丢 `undefined` 和 `null`，空字符串会保留**——有些接口用空串表达"全部"或"清空"。

### 7.4 一个应用只装配一次

不要在模块顶层建"全局默认实例"或"全局单例 client"。同一个页面里可能有多个 app、多个账号，全局实例会互相覆盖 token；SSR 场景下更会在进程内跨请求串号。

每个 app 在自己的装配文件（例如 `src/pan.ts`）里 `createAuth()` + `createOpenApi()` + `createScene()` 各一次，页面只 import 装配好的实例。`api` 和 `scene` 刻意都不提供默认实例，就是为了逼出这一个装配点。

---

## 排查清单

接不通的时候按这个顺序过一遍：

1. **代理**：`curl http://localhost:5173/pan/rest/2.0/xpan/nas?method=uinfo` 返回的是百度 JSON，还是 Vite 的 `index.html`？
2. **token**：`auth.tokenStore.get()` 是不是空串？（空串会抛 `ConfigError`，不是网络错误）
3. **授权模式**：`response_type=token`，回调页由 `panOauthCallback()` 产出；`redirectUri` 与控制台登记值是否逐字符一致？
4. **应用目录**：路径是不是 `/apps/<应用名>/...`？错了是 `20020` 或 `31064`。
5. **错误码取值方式**：是不是在用 `apiErrno(error)`？（`HttpError` 上没有 `errno`）
6. **分页参数**：`limit` 是否配了 `start`？`listall` 是否用了 `cursor`？
7. **重试**：`31034` / `111` 会自动重试，看到它们重试三次才失败是正常现象。
