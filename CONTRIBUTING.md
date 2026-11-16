# 贡献指南

感谢你愿意花时间改进这个 SDK。本文说明开发环境、代码约定、测试要求、提交规范和发布流程。

参与本项目即表示你同意遵守 [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，不要开公开 issue；如遇不当行为，也请按同一渠道私信维护者。

## 开发环境

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 18.17`（只用于构建、类型检查与测试） |
| pnpm | `10.x`（仓库声明了 `packageManager: pnpm@10.13.1`） |
| 浏览器 | 手工验证时需要支持 `fetch` / `Blob` / `localStorage` 的现代浏览器（ES2022） |

```bash
git clone https://github.com/baidu-netdisk/baidu-drive-sdk-js.git
cd baidu-drive-sdk-js
pnpm install
```

## 命令

日常开发只需要四条根命令：

```bash
pnpm install       # 安装依赖
pnpm type-check    # tsc --noEmit
pnpm test          # vitest run
pnpm build         # tsup 构建 + 拷贝手写静态文件到 dist/
```

`pnpm build` 之后才会产出 `dist/`。`examples/` 下的示例通过 workspace 引用 SDK 的构建产物，**所以改完 SDK 要先 `pnpm build`，再启动示例**，否则示例解析不到最新的包。

## 目录与职责

```text
src/
├── index.ts                 聚合出口（api + scene）
├── api/                     api 层：协议、传输、端点、错误码、重试、授权
│   ├── transport.ts         发请求 / 读响应 / 传输错误
│   ├── client.ts            baseUrl + 凭证 + 解析钩子
│   ├── openapi.ts           开放平台适配 + defineApi
│   ├── endpoints.ts         端点描述（纯数据）
│   ├── errno.ts             errno 文案 / 重授权判定
│   ├── retry.ts             重试
│   └── auth/                简化模式授权 + 凭据缓存 + Vite 插件
└── scene/                   scene 层：业务编排
    ├── index.ts             createScene() 聚合
    ├── file-browse/
    ├── file-manage/
    ├── file-upload/
    ├── file-download/
    └── user-info/
examples/                    可运行的示例应用（pnpm workspace）
docs/                        对外文档
scripts/                     构建与冒烟脚本
```

### 硬性约定

1. **端点描述只能写在 `src/api/endpoints.ts`。**
   端点是跨场景共享的（例如 `FILE_METAS` 浏览和下载都要用），写进 scene 包会出现多份，改文档要改多处。新增端点用 `describeApi`，注释里留官方文档链接，并写清实测到的反直觉行为。

2. **scene 包只做编排。**
   典型工作只有四类：补默认参数、解码/派生、`withRetry`、把逐条 `errno` 翻译成异常。不要新增端点，不要在 scene 层重复判断顶层 `errno`（api 层已经抛 `ApiError` 了）。

3. **不要加默认实例 / 模块级单例。**
   `api` 与 `scene` 刻意都不提供默认实例。一个页面里可能有多个 app、多个账号，全局实例会串 token；SSR 场景下会跨请求串号。所有实例由调用方装配后传入。

4. **依赖方向单向：`scene` → `api`。**
   `api` 不 import 任何 scene 代码；`api/auth` 只用标准 Web API，靠 `{ get, set, clear }` 的结构类型与请求层连接。不要为了少写一个参数把方向反过来。

5. **源码一律 TypeScript，不引 React、不引 Node 内建模块。**
   `src/` 下只接受 `.ts`（全局唯一的 `.js` 例外是第 6 条的 `vite.mjs`）；不允许出现 JSX、React、`node:*` 导入。`scripts/` 和构建配置例外。包发布的是编译产物（ESM `.js` + `.d.ts`），不要把 `.js` 源码或构建结果提交进仓库。

6. **`src/api/auth/vite.mjs` 是手写 JS，不要改成 `.ts`。**
   它会被 app 的 `vite.config.ts` 直接引用，而 Vite 加载配置时把 `node_modules` 里的依赖交给 Node，Node 加载不了裸 `.ts`。类型写在 `vite.d.mts` 里，两份必须同步改。

7. **新增 scene 包要接进 `createScene`。**
   在 `src/scene/index.ts` 里：导入工厂、让 `Scene` 接口 `extends` 新接口、在 `createScene()` 返回对象里展开。扩展前确认方法名不与现有场景冲突——摊平到同一个对象的前提就是没有重名。

8. **错误码常量要与 Go SDK 对齐。** 新增 `Errno` 常量时命名对齐 Go 的 `api.Errno*`（去掉 `Errno` 前缀作为属性名）；含义有歧义的码不加常量，统一走 `errnoMessage(errno)` 取通用文案。

## 测试

- 单测文件与被测文件同级：`src/<module>/index.test.ts`。
- **单测一律用假端点，绝不打真实接口。** 场景工厂的构造签名支持 `OpenApi | Partial<Deps>`，直接传假实现：

```ts
const browse = createFileBrowse({
  listFiles: async () => ({ errno: 0, guid_info: '', list: [] })
});
```

- 需要拦 `fetch` 时用 `vi.stubGlobal('fetch', ...)`，不要 mock 整个模块——这样能顺带覆盖传输层。
- `auth` 的用例需要 `window` / `localStorage` / `postMessage`，在文件头加 `// @vitest-environment happy-dom`；其余用例跑在 Node 环境。
- 派生字段（`available`、`usedRatio`、`displayName`）必须配"字段缺失 / 为 0 / 越界"的用例。
- 修 bug 时先写一个能复现的失败用例，再改实现。

## 真实环境验证纪律

单测覆盖不到平台行为，上传、删除这类方法需要真实接口验证。这些操作会**真实改动用户网盘**，必须守纪律：

1. **只在专用测试目录里操作**：`/apps/<应用名>/sdk-test/`。不要碰应用目录下已有的用户数据，更不要碰应用目录之外的路径。
2. **用小文件**：几 KB 的文本或内存里生成的小 `Blob` 就够验证链路。唯一例外是多分片路径——它必须用真实的 4MB 以上文件，不能靠调小分片大小偷懒（实测会被 HTTP 400 拒掉）。
3. **验完即删，只删自己刚建的**。删除没有回收站语义保证，优先用可恢复的操作（`mkdirIfNotExist` → `copy` → `rename`）验证，删除放最后。
4. **不要用生产账号或他人的 AppKey 做验证**。用自己名下的测试应用。
5. **不要把 token、dlink、Bduss/STOKEN 等凭据写进代码、测试、日志或 PR 描述**。验证时打印请求 URL 要先把 `access_token` 打码。
6. **验证方式与结果写进 PR 描述**：做了什么、哪个接口、观察到什么，这样评审能在不重跑的情况下判断风险。

## 提交规范

### Conventional Commits

所有 commit 必须符合 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范，CI 会逐条校验 PR 内的 commit 消息：

```text
<type>(<scope>): <subject>
```

- `type` 取值：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`、`perf`、`ci`、`build`、`revert`
- `scope` 建议用模块名：`api`、`scene`、`auth`、`browse`、`upload`、`download`、`manage`、`user`、`docs`、`ci`
- `subject` 用一句话说清改了什么；正文说明"为什么"和"怎么验证的"

示例：

```text
feat(scene): 新增 categoryStats 分类统计
fix(api): 非 2xx 响应也提取 error_code
docs: 补充同源代理的 Nginx 配置
chore(deps): 升级 vitest 到 4.x
```

破坏性变更在 `type` 后加 `!`（如 `feat(api)!: ...`），正文首行写 `BREAKING CHANGE:`，并同步 `CHANGELOG.md`。

### PR

- 一个 PR 只做一件事，评审成本会低很多；不要顺手改无关文件。
- 按 [PR 模板](./.github/PULL_REQUEST_TEMPLATE.md) 填写：改动说明、改动类型、关联 issue、测试方式。
- 提交前自查：已跑过 `pnpm type-check`、`pnpm test`、`pnpm build`；公开 API 变更已同步 README / docs；涉及接口行为变更已更新 `docs/pitfalls.md`（如适用）；不含敏感信息。

## 文档同步

改到下面这些内容时，请一并更新文档：

| 改动 | 要更新的文档 |
| --- | --- |
| 公开 API 增删改 | `README.md` 的「Scene 方法一览」/「API 方法一览」 |
| 新增或修改端点 | `src/api/endpoints.ts` 注释 + `docs/architecture.md` 的扩展指引 |
| 新踩到的平台坑 | `docs/pitfalls.md` |
| 代理、部署方式变化 | `docs/proxy.md` |
| 行为不兼容变更 | `CHANGELOG.md`，并在 PR 里显式标注 |

## 提交前检查

```bash
pnpm type-check
pnpm test
pnpm build
```

三条都要通过。CI 还会额外执行：

- `scripts/check-version.mjs`：校验 `VERSION` 与 `package.json` 版本一致
- `scripts/smoke-test.mjs`：检查 10 个导出入口都能被解析
- `pnpm dlx publint`：校验 `package.json` 的 exports 映射与类型声明
- 示例应用 `type-check` / `build` / `test`

另外：

- 格式化遵循 `.prettierrc.json`（单引号、无尾逗号、行宽 100、带分号）；缩进 2 空格、LF、文件末尾留空行（见 `.editorconfig`）。
- 不要提交 `dist/`、`node_modules/`、`.env*`、覆盖率产物。
- 不要提交任何真实凭据（`access_token`、`dlink`、SecretKey）。AppKey 是公开标识，但也没必要把个人应用的 AppKey 提交进仓库。
- 新增运行时依赖前先确认许可证与 Apache-2.0 兼容，并同步更新 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 发布

发布由根目录的 `VERSION` 文件驱动，不要手改 `package.json` 的版本号：

1. 修改 `VERSION`（例如 `0.2.0`），在 PR 里说明变更
2. 合并到 `main` 后，Release 工作流会读取 `VERSION`，同步到 `package.json`、跑类型检查与测试、构建并冒烟（`pnpm version:check` 也会在 CI 与 `prepublishOnly` 中校验两者一致）
3. 自动打 `v<version>` tag 并创建 GitHub Release
4. 仓库配置了 `NPM_TOKEN` secret 时会执行 `npm publish --access public`；没有配置则只创建 GitHub Release

## 许可证

本项目以 [Apache-2.0](./LICENSE) 发布。提交代码即表示你同意以同一许可证授权你的贡献。第三方组件许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 不要做的事

- 不要为了"少一次请求"把两个场景的方法合成一个。scene 方法的粒度是"用户心里的一件事"。
- 不要在重试白名单里加 `-6`（要重新授权）或 `-9`（路径真的不存在）。
- 不要在文档或注释里写真实 AppKey、真实账号、内部地址、内部系统名。
- 不要在没有反向代理的环境里承诺"开箱即用"——浏览器直连开放平台一定是 CORS 失败。
