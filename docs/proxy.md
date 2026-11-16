# 同源代理配置

浏览器访问百度网盘开放平台必须经过同源代理。这不是可选优化，而是硬约束：**没有代理，SDK 在这个浏览器里就跑不起来**。

本文覆盖四件事：为什么必须代理、前缀约定、四种部署形态的完整配置、以及怎么验证代理确实配对了。

## 1. 为什么必须代理

开放平台的响应里没有 `Access-Control-Allow-Origin`。涉及三个 host：

| Host | 用途 |
| --- | --- |
| `pan.baidu.com` | 开放平台主接口（用户、容量、列表、搜索、文件管理、预上传、创建文件、授权页） |
| `d.pcs.baidu.com` | 分片上传、单步上传、dlink 下载 |
| `ndN.baidupcs.com` | dlink 302 之后跳到的随机 CDN 节点（不由你直接请求） |

在这三个 host 上，浏览器的跨域 `fetch` 都会被拦。表现分两种：

- 浏览器控制台直接报 CORS 错误，请求根本没发出去；
- 如果静态托管有 SPA 兜底（`/(.*) → /index.html`），请求被兜底吃掉，返回 **HTTP 200 + HTML**。SDK 会把它报成 `HttpError`（`kind: 'parse'`，message 里带响应片段），而不是"成功但数据为空"。

代理的做法是：让浏览器只请求**同源前缀**，由 dev server 或边缘层转发到上游。这样对浏览器而言是同源请求，不触发 CORS。

## 2. 前缀约定

默认两条前缀：

| 前缀 | 上游 | 覆盖 |
| --- | --- | --- |
| `/pan` | `https://pan.baidu.com` | 所有 `/rest/2.0/xpan/*`、`/rest/2.0/pcs/file`、`/api/quota`、`/api/categoryinfo` |
| `/pcs` | `https://d.pcs.baidu.com` | `/rest/2.0/pcs/superfile2`、单步上传、dlink |

需要在**三个地方**保持一致：

```ts
// ① 主接口实例，默认就是 '/pan'
const api = createOpenApi({ tokenStore: auth.tokenStore });

// ② 上传/下载域名实例，baseUrl 必须是 '/pcs'
const transfer = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/pcs' });

// ③ 下载的 dlink 也在这个 host 上，proxyPrefix 必须同样是 '/pcs'（这也是默认值）
const sc = createScene({ api, transfer, proxyPrefix: '/pcs' });
```

改前缀时三处一起改，漏一处就会出现"列表能看、上传 404"这类半通不通的状态。

`createOpenApi()` 的默认前缀是一个常量：`DEFAULT_BASE_URL = '/pan'`（从 `baidu-drive-sdk-js/api` 导出，可以直接引用）。它**刻意不读任何构建工具的 env**——不碰 `import.meta.env`，同一个包才能同时用在 Vite、Webpack 和原生 ESM 里。

前缀不叫 `/pan`（比如为了避免和别的应用撞路径），显式传进去：

```ts
const api = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '/api/pan' });
```

前缀改了，反代规则和 `createScene`（或 `createFileDownload`）的 `proxyPrefix` 要一起改。

## 3. Vite dev

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
        // 上游路径没有 /pan 前缀，转发前去掉
        rewrite: (path) => path.replace(/^\/pan/, '')
      },
      '/pcs': {
        target: 'https://d.pcs.baidu.com',
        changeOrigin: true,
        // dlink 会 302 到 CDN；由 dev server 跟随，浏览器才拿得到字节
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/pcs/, '')
      }
    }
  }
});
```

要点：

- `changeOrigin: true` 把 `Host` 头改成上游域名。少了它，部分接口会按错误的站点上下文处理。
- `rewrite` 必须去掉前缀。上游路径是 `/rest/2.0/xpan/file`，不是 `/pan/rest/2.0/xpan/file`。
- `/pcs` 的 `followRedirects: true` 是给 `fetchBlob` 用的：dlink 返回 302，浏览器自己跟随就跨域到 CDN 了。
- 配置里**只有两条规则**，不要按接口逐条加。`/api/quota`、`/api/categoryinfo` 不在 `/rest/2.0/xpan` 下，逐条枚举一定会漏，而且新增端点要改两次。

`panOauthCallback()` 与代理无关，但授权回调页也走同一个 dev server，通常一起配。它默认产出 `oauth-callback.html`，文件名要和开放平台控制台登记的 `redirectUri` 路径一致：

```ts
panOauthCallback({ fileName: 'oauth-callback.html' })
```

## 4. Nginx

```nginx
server {
  listen 443 ssl;
  server_name app.example.com;

  # 开放平台主接口
  location /pan/ {
    proxy_pass https://pan.baidu.com/;      # 结尾的 / 表示替换掉 /pan/
    proxy_set_header Host pan.baidu.com;
    proxy_ssl_server_name on;                # HTTPS 上游必须显式开 SNI
    proxy_pass_request_body on;              # filemanager / create 是 POST，保留请求体
  }

  # 上传域名：multipart 请求体要原样透传
  location /pcs/ {
    proxy_pass https://d.pcs.baidu.com/;
    proxy_set_header Host d.pcs.baidu.com;
    proxy_ssl_server_name on;
    proxy_pass_request_body on;
    client_max_body_size 64m;                # 按分片大小和平台上限调整
    proxy_request_buffering off;
  }

  # 静态产物 + SPA 兜底
  root /srv/app/dist;
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }

  # 授权回调页是独立静态文件，别被 SPA 兜底吃掉
  location = /oauth-callback.html {
    try_files $uri =404;
  }
}
```

两个容易踩的点：

- `proxy_pass` 结尾的 `/` 决定路径怎么拼。写成 `proxy_pass https://pan.baidu.com;`（无尾斜杠）会把 `/pan/...` 原样带上去，上游收到 404。
- **Nginx 默认不跟随上游 302。** dlink 的 302 会被原样返回给浏览器，而 `Location` 指向 `ndN.baidupcs.com`（跨域、无 CORS 头）——所以 `/pcs` 上只做按钮下载（导航）没问题，**把字节读进 JS 需要额外的服务端出口**：

```nginx
# 一个会跟随 302 并同源回传字节的小服务
location /api/file {
  proxy_pass http://127.0.0.1:8787/api/file;
  proxy_set_header Host 127.0.0.1:8787;
}
```

该服务的职责是：校验 dlink 域名白名单 → 服务端 `redirect: 'follow'` → 把流回传。不要在网关里把它做成任意 URL 代理。

## 5. Vercel

静态托管的 `routes` 等价于上面两条 `location`：

```json
{
  "routes": [
    { "src": "/pan/(.*)", "dest": "https://pan.baidu.com/$1" },
    { "src": "/pcs/(.*)", "dest": "https://d.pcs.baidu.com/$1" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```

要点：

- **顺序有意义**：两条上游 `routes` 必须在 `handle: "filesystem"` 之前，否则静态文件处理器会先接住；SPA 兜底放最后。
- `$1` 捕获的是去掉前缀后的路径，效果等同 Nginx 的 `proxy_pass .../`。
- rewrite 只做转发、**不跟随 302**。所以按钮下载（浏览器导航）可用，`fetchBlob` 读字节在纯 rewrite 下不保证可用——需要读字节时同样要加一个服务端函数跟随跳转。
- 授权回调域名不能是每次部署都变的预览域名：平台无法预登记，登录会失败。用生产域名或自定义域名。
- 回调页 `oauth-callback.html` 由构建产出，确保 `handle: filesystem` 能命中它，别被 SPA 兜底替换成 `index.html`。

## 6. 同源部署

如果页面本身就部署在 `pan.baidu.com` 上（例如作为开放平台内的页面、或被部署到该域名下的某个路径），主接口不再需要前缀——它本来就是同源的。

此时把主接口的 `baseUrl` 显式设为空串：

```ts
// 空串表示"不加前缀，直接打同源路径"
const api = createOpenApi({ tokenStore: auth.tokenStore, baseUrl: '' });
const listFiles = api.defineApi(LIST_FILES);
// 实际请求：/rest/2.0/xpan/file?method=list&...
```

注意两点：

- 空串是合法值：`createOpenApi()` 用 `??` 取默认值，只对 `null` / `undefined` 生效。传 `''` 就是"不加前缀"，**省略** `baseUrl` 才会回落到 `DEFAULT_BASE_URL`（`'/pan'`）。
- 上传/下载域名（`d.pcs.baidu.com`）是**另一个 origin**，同源部署不会自动解决它。页面在 `pan.baidu.com` 上时，`/pcs` 前缀仍然要配一条代理，或者把 `baseUrl` 指向你自己的转发路径。若页面本身就在 `d.pcs.baidu.com` 上，则 `transfer` 的 `baseUrl` 也可以设为 `''`，`createScene` 的 `proxyPrefix` 同步设为 `''`。

## 7. 按前缀整体转发，不要逐条枚举

两个反例说明了为什么：

| 端点 | 路径 | 逐条枚举时容易漏掉 |
| --- | --- | --- |
| 容量 | `/api/quota` | 不在 `/rest/2.0/xpan` 下，也没有 `method` 参数 |
| 分类统计 | `/api/categoryinfo` | 同上 |

第三类风险是路径前缀撞车：`/rest/2.0/xpan/file` 和 `/rest/2.0/pcs/file` 都做文件操作，但一个在 `pan.baidu.com`、一个在上传域名——逐条枚举时很容易把单步上传写到 `/pan` 规则里，结果 404。

结论：代理规则只按 host 划分（`/pan`、`/pcs`），不按接口划分。

## 8. 验证

配完先不要开页面，用 `curl` 验证代理：

```bash
# ① 主接口：应该返回百度 JSON（可能带 errno），不是 HTML、不是 404
curl -i 'http://localhost:5173/pan/rest/2.0/xpan/nas?method=uinfo&access_token=test'

# ② 容量接口：验证不在 /rest/2.0/xpan 下的路径也被转发
curl -i 'http://localhost:5173/pan/api/quota?checkfree=1&access_token=test'

# ③ 上传域名：应该返回百度 JSON（不是 405、不是 404）
curl -i -X POST 'http://localhost:5173/pcs/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&path=%2Fapps%2Fdemo%2Fa.txt&uploadid=x&partseq=0'

# ④ dlink：浏览器行为用 curl 模拟不了，但在浏览器控制台里应看到 206 与字节，而不是 CORS 错误
```

判断标准：

- `Content-Type` 是 JSON，不是 `text/html`；
- 响应里有 `errno` 或 `error_code` 字段（哪怕是错误码，也说明代理通了——业务错误是下一步的事）；
- 请求头里 `Host` 是上游域名（`changeOrigin` 生效）。

页面侧的排错顺序：

1. 打开 DevTools → Network，看请求 URL 是不是 `/pan/...`（前缀对不对）
2. 看响应体第一条字符是 `{` 还是 `<`（HTML 说明代理没命中，被 SPA 兜底了）
3. 看 SDK 抛的错：`HttpError.kind === 'parse'` → 代理问题；`kind === 'http'` + 404 → `rewrite`/尾斜杠问题；`ApiError` → 业务错误码

## 9. 安全注意事项

- **代理白名单固定上游**。不要写成"请求什么就转发什么"，否则它会变成一个开放代理，被人用来穿透内网或隐藏来源。
- **`access_token` 在查询串里**，会被反代的访问日志记录。生产环境建议：关闭 query 日志、或把令牌改到 `Authorization` 头（`createClient` 支持 `tokenHeader`）、或缩短日志保留期。
- **不要在代理层缓存**。带 token 的响应不能进共享缓存；dlink 下发的字节也不要缓存到 CDN。
- 回调页会短暂把 token 放进 URL，页面脚本已经用 `history.replaceState` 擦掉地址栏，但**浏览器历史与反代日志仍可能留有记录**——这是简化模式的固有代价，介意的话应改用授权码模式并在服务端换取 token。
