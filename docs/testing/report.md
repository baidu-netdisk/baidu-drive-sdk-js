# 测试报告

本文件记录每个发布版本在提交时的确定性验证证据。格式与 [`baidu-drive-sdk-go/docs/testing/report.md`](https://github.com/baidu-netdisk/baidu-drive-sdk-go/blob/main/docs/testing/report.md) 保持一致。

> 说明：本仓库所有单元测试都使用**假端点**（注入到 `createOpenApi` 或各场景工厂），不访问真实接口。真实接口的行为结论来自内测阶段的实测记录，整理在 [接口坑位合集](../pitfalls.md)，不是本文件的证据。

## 2026-11-13: 0.1.0 发布验证

本节记录 0.1.0 的准备阶段验证证据：门禁命令与结果、覆盖率、用例分布，以及尚未覆盖的边界。

### 执行结果

```
pnpm install --frozen-lockfile          → OK
node scripts/check-version.mjs          → ✅ 版本一致：0.1.0
bash scripts/check-sensitive-files.sh --self-test
                                        → ✅ 自测通过：能拦住 .pem/.env/credentials.json
bash scripts/check-sensitive-files.sh   → ✅ 未发现敏感文件
pnpm run format:check                   → All matched files use Prettier code style
pnpm type-check                         → OK（tsc --noEmit，strict）
pnpm test                               → 13 files / 166 tests passed
pnpm audit --audit-level=high           → No known vulnerabilities found
pnpm build                              → OK（tsup ESM + DTS，10 个入口）
node scripts/smoke-test.mjs             → smoke test passed: 10 subpaths
pnpm dlx publint@0.3.25                 → All good!
```

示例应用（引用 SDK 的 `dist/` 产物，验证 exports 与类型声明在真实使用方可用）：

```
pnpm --filter example-react-file-browser type-check   → OK
pnpm --filter example-react-file-browser build        → OK（Vite 生产构建）
pnpm --filter example-react-file-browser test         → 1 file / 4 tests passed
```

运行环境：macOS (darwin)、Node.js v22.19.0、pnpm 10.13.1、TypeScript 5.7.3、Vitest 4.1.12、tsup 9、happy-dom 21。

### 覆盖率统计

`pnpm test:coverage`（`@vitest/coverage-v8`，`src/**` 为统计范围，剔除 `*.test.ts` 与纯 re-export 的 barrel）：

| 模块 | Statements | Branch | Funcs | Lines |
| --- | --- | --- | --- | --- |
| 全量 | 90.37% | 82.90% | 86.09% | 92.48% |
| `src/api`（传输/client/端点/openapi/errno） | 86.89% | 82.20% | 82.60% | 89.65% |
| `src/api/auth`（授权/凭据/vite 插件） | 88.16% | 80.90% | 82.22% | 92.19% |
| `src/scene`（聚合） | 100% | 100% | 100% | 100% |
| `src/scene/file-browse` | 98.61% | 79.59% | 96.00% | 98.46% |
| `src/scene/file-manage` | 98.27% | 92.15% | 94.44% | 97.95% |
| `src/scene/file-upload` | 93.75% | 88.00% | 86.95% | 94.59% |
| `src/scene/file-download` | 80.76% | 72.09% | 66.66% | 82.97% |
| `src/scene/user-info` | 100% | 93.54% | 100% | 100% |

`src/api/transport.ts` 覆盖率 81.31%：覆盖了脱敏、已取消 signal、响应体读取失败、超时与 HTML 响应体五组场景。剩余未覆盖分支集中在 `client.ts` 的凭证通道组合与 `file-download` 的 objectURL/DOM 分支。

### 关键回归用例

下面这些行为一旦回退，会在真实使用中造成数据或安全问题，因此都有专门用例守着：

| 必须守住的行为 | 守护它的用例 |
| --- | --- |
| 大文件上传不得把整份文件读进内存 | 分片 MD5 并发峰值断言为 1 |
| 错误对象不得携带凭据 | `HttpError.url` 不含 `access_token`（网络错误 / 非 2xx 两条路径） |
| 取消后不得继续发请求 | 已取消的 signal 不触发 `fetch`；`withRetry` 不执行任务 |
| 取消后不得继续传分片 | 只上传第 0 片并抛「上传已取消」 |
| `folder=1` 时文件名不能是 `"undefined"` | 用路径最后一段兜底 |
| `listAll` 传超限 `limit` 仍要取全 | 5000 条目录 + `limit: 2000` 取全 5000 |
| 翻页超上限不得静默截断 | 抛 `BrowseTruncatedError`；放宽 `maxPages` 后可取全 |
| 空 `block_list` 不得跳过分片 | 等价于 `[0]`，只传第 0 片 |
| 读响应体失败要归到 `HttpError` | `kind === 'network'`，不漏裸异常 |

### 用例分布

| 测试文件 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `src/api/transport.test.ts` | 8 | URL 脱敏、已取消 signal、响应体读取失败、超时、HTML 响应体 |
| `src/api/errno.test.ts` | 13 | errno 文案、兜底文案、`needsReauth`、`Errno` 常量、`isErrno` 两个载体 |
| `src/api/retry.test.ts` | 9 | 可重试判定、指数退避序列、取消中断、取消后不执行任务 |
| `src/api/openapi.test.ts` | 11 | 默认 `baseUrl`、token 注入位置、`ConfigError`、`request_id` 大整数、`ApiError` 字段 |
| `src/api/auth/oauth.test.ts` | 12 | 授权 URL 参数、state 校验、来源校验、tab/popup、超时与弹窗拦截 |
| `src/api/auth/credential.test.ts` | 8 | 存储 key 隔离、过期与 scope 判定、手填 token、`tokenStore` 语义 |
| `src/api/auth/vite.test.ts` | 10 | 回调页常量一致性、token 不落页面、dev/build 注入、Vite `base` 子路径 |
| `src/scene/index.test.ts` | 4 | `createScene` 方法摊平、裸 `OpenApi` 用法、缺 `transfer` 的 `ConfigError` |
| `src/scene/file-browse/index.test.ts` | 24 | 三套分页模型、`limit` 补 `start`、URL 解码、`onlyFolder` 兜底、截断抛错 |
| `src/scene/file-manage/index.test.ts` | 20 | 两种「不存在」、目录 `31301`、逐条 `errno`、三种 `filelist` 结构、幂等建目录 |
| `src/scene/file-upload/index.test.ts` | 20 | 选路、三步流程、云端 MD5 覆盖、秒传、串行 MD5、空 `block_list`、取消 |
| `src/scene/file-download/index.test.ts` | 13 | dlink 拼 token、同源地址改写、`fetchBlob`、无 DOM 时的提示 |
| `src/scene/user-info/index.test.ts` | 14 | 驼峰映射、`displayName` 回退、`available`/`usedRatio`、`total` 为 0、`formatBytes` |

### 未覆盖与未验证

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 真实接口联调 | 未纳入 CI | 需要真实账号与 AppKey；本仓库单测一律打桩，避免把别人的配额与文件卷进测试 |
| 秒传（`return_type === 2`） | 只有单测 | 实测重复 `precreate` 仍返回 `return_type: 1`，真实命中条件未知，见 [坑位 4.9](../pitfalls.md) |
| `categoryStats` | 单测通过、实测持续 `31034` | 无法判断是频控还是权限未开放，见 [坑位 2.5](../pitfalls.md) |
| `searchSemantic` | 单测通过、实测空结果 | 接口两种情况都是 `errno 0` + 空列表，无法区分无权限与无命中，见 [坑位 2.4](../pitfalls.md) |
| 单步上传 `403 + 31064` | 条件性 | 部分应用上下文里会被拒，可用 `forceSlice: true` 绕过，见 [坑位 4.8](../pitfalls.md) |
| 浏览器实机（Chrome/Safari/Firefox） | 未纳入 CI | 目前只在示例应用的 Vite dev/build 流程中验证过模块解析与构建产物 |
| Node 18 / 20 | 未纳入 CI | 本机用 Node 22 验证；CI 固定 Node 20 |
| 覆盖率阈值 | 未设置 | 只有覆盖率报告，没有「低于阈值就失败」的门禁 |

### 与 Go SDK 的验证差异

- Go 仓库的 GitHub CI 只做提交规范与敏感文件两步检查；`go test` 在内部 `workflows/ci.yml` 里跑，覆盖率只打印百分比、不设阈值；`govulncheck` 按团队门禁文档是在 tag 上执行，并不在仓库 CI 里。
- 本仓库的 CI 多了格式检查、依赖审计、产物冒烟、`publint` 与示例构建；但仍没有覆盖率阈值，也没有 `-race` 这类并发检查（浏览器端没有对应物）。
- 两者的 `api` / `scene` 分层与错误模型一致，但本 SDK 的 `api` 层额外包含浏览器授权（简化模式），Go 版是服务端授权码/设备码模式，不可直接对照。
