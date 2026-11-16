# 安全策略

## 支持版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| `0.1.x` | 是（当前发布线） |
| `< 0.1.0` | 否 |

`0.x` 阶段不承诺长期维护多个次版本：安全修复只会进入最新版本，请保持升级。

## 私下报告漏洞

**请不要为安全漏洞开公开 issue、公开讨论区帖子或公开 PR。**

推荐用 GitHub 的私密漏洞报告：

1. 打开 [baidu-netdisk/baidu-drive-sdk-js](https://github.com/baidu-netdisk/baidu-drive-sdk-js) → **Security** → **Report a vulnerability**
2. 按表单填写：受影响版本、影响面、复现步骤、你建议的修复方向
3. 如果无法使用私密报告，先发一条只包含"我要报告一个安全问题"的 issue（不含细节），维护者会给出后续渠道

> 说明：私密报告依赖仓库侧开启 GitHub Private Vulnerability Reporting。仓库公开后该入口才会生效；在生效之前，请按第 3 条先发一条不含细节的 issue 建立联系。

报告中**不要包含**下列内容，它们是凭据，一旦进入 issue 或附件就等于泄露：

- `access_token` / `refresh_token`
- `dlink`（它自带 `access_token`）
- `Bduss` / `STOKEN` 之类的登录态
- 任何 `client_secret` / SecretKey
- 你名下应用的 AppKey（AppKey 本身是公开标识，但贴出来会暴露"这是哪个应用"）

可以安全提供的是：错误码（`errno` / `error_code`）、`request_id`、HTTP 状态码、脱敏后的请求路径、SDK 版本、复现步骤。**贴 URL 前请手动删掉 `access_token=` 之后的部分。**

## 响应流程

- **5 个工作日内**确认收到并给出初步判断（是否复现、影响面、修复排期）。
- **30 天内**给出修复计划；严重问题（可导致凭据泄漏或数据损坏）优先进入下一个小版本。
- 修复发布前不公开细节；发布后在本文件与 `CHANGELOG.md` 中记录。
- 修复发布后，会在 `CHANGELOG.md` 里记录"安全修复"并致谢报告者（除非你希望匿名）。
- 如果判断不属于本项目范围（例如平台自身的接口漏洞），会说明理由，并建议向百度网盘开放平台反馈。

## 凭据是怎么存的

浏览器侧走 **OAuth 2.0 简化模式（implicit，`response_type=token`）**，没有服务端，也不接触 SecretKey。

- 授权得到的 `access_token` 存在**浏览器 `localStorage`**，key 形如 `pan-oauth-v1-<hash>`（由 appKey + 回调地址 + scope 哈希而来，用于多应用隔离，**不是加密**）。
- 任何能在该 origin 执行的 JS 都能读到它。因此 **XSS 等于 token 泄露**：应用侧必须做输出转义、避免 `innerHTML`、配好 CSP。
- 简化模式**没有 refresh_token**。token 过期后只能重新授权，SDK 不会尝试静默续期；`tokenStore.get()` 在过期或 scope 不足时返回空串，请求层据此抛 `ConfigError`。
- `logout()` 只删除本地缓存，不会让服务端的 token 失效。要彻底吊销，请到开放平台控制台或账号安全设置里操作。
- 同源代理会看到完整请求 URL，而 `access_token` 默认在查询串里。生产环境的反代访问日志请关闭 query 记录，或缩短日志保留期。
- 可以把 `CredentialStore` 换成 `sessionStorage`、内存或自己的后端存储（`createAuth({ store })`），以缩小 XSS 可读取的窗口。

## dlink 的特殊风险

`scene/file-download` 返回的 `dlink` 是**带凭据的下载地址**——它上面拼了 `access_token`。它还会出现在 DOM 的 `href` / `src` 属性里。

硬性要求：

- 不要把 `dlink` 写进日志、埋点、错误上报、数据库或任何持久化存储
- 不要把它贴到公开页面、工单、聊天记录或截图里
- 不要把它当长期链接缓存：dlink 有有效期，需要时重新取
- 需要把文件地址交给第三方时，先自己服务端中转，不要直接外发 dlink

SDK 在内部生成的下载锚点上加了 `rel="noreferrer"`，减少地址通过 Referer 外泄，但这只是兜底，不是保证。

## 依赖与供应链

- 本项目以 [Apache-2.0](./LICENSE) 发布。
- 运行时依赖只有 `spark-md5`（浏览器没有 MD5，上传分片校验需要）；许可证与用途见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。引入新依赖需要同步更新该文件，并确认许可证与 Apache-2.0 兼容。
- 构建产物是 ESM + `.d.ts`，没有 postinstall 脚本，也没有运行时代码下载。
- 安装时建议使用 lockfile（`pnpm install --frozen-lockfile`），并在 CI 里跑 `pnpm audit`。
- 发布由 `VERSION` 文件驱动，npm 发布使用仓库配置的 `NPM_TOKEN`；没有该 secret 时只创建 GitHub Release。

## 使用方的安全建议

1. **全站 HTTPS**：token 在浏览器里流转，明文 HTTP 会被中间人截获。
2. **限制代理上游**：同源代理只允许转发到固定白名单域名，不要做成"请求什么就转发什么"的开放代理。
3. **收紧 CSP**：至少限制 `connect-src` 到自己的域名（代理前缀），减少 token 被外发的面。
4. **不要在前端放 SecretKey**：`VITE_*` 变量会被内联进构建产物，任何密钥都不能放进去。
5. **对写操作做应用侧确认**：`upload` / `remove` / `copy` 会真实改动用户网盘，UI 层要有二次确认和路径校验。
6. **处理重新授权**：`ApiError` 的 `-6` / `20016` / `20017` / `31045` 都是凭据失效，用 `needsReauth(errno)` 判断，引导用户重新授权，而不是无限重试。
7. **及时升级**：安全修复只进入最新版本，请关注 `CHANGELOG.md` 与 GitHub Release。
