# React 文件浏览器示例

一个用 React + Vite 写的只读网盘浏览器：登录百度网盘账号后浏览根目录、逐级进入子目录、看文件大小和修改时间。它演示如何用 `baidu-drive-sdk-js` 的四个子路径模块（`api/auth`、`api`、`scene/file-browse`、`scene/user-info`）拼一个真实应用，包括浏览器端 OAuth 授权、接口调用和错误翻译。

## 前置条件

- Node.js >= 18.17、pnpm 10
- 百度网盘开放平台的 **AppKey**（需要自己申请）
- 在开放平台控制台为应用登记回调地址：`http://localhost:5175/oauth-callback.html`
  （本示例用 implicit 简化模式，token 由百度直接带回这个回调页，不需要 SecretKey 和自建后端）

## 跑起来（4 步）

```bash
# 1. 在仓库根目录安装依赖，并把 SDK 构建到 dist/（示例通过 workspace:* 引用构建产物）
pnpm install
pnpm build

# 2. 配置 AppKey
cp examples/react-file-browser/.env.example examples/react-file-browser/.env.local
# 编辑 .env.local，填入 VITE_PAN_APP_KEY=<你的 AppKey>

# 3. 启动示例
pnpm --filter example-react-file-browser dev     # http://localhost:5175

# 4. 打开 http://localhost:5175，点「登录百度网盘」完成授权
```

其他命令（同样在仓库根执行）：

```bash
pnpm --filter example-react-file-browser type-check   # 只做类型检查
pnpm --filter example-react-file-browser build        # 类型检查 + 产出 dist/
pnpm --filter example-react-file-browser test         # vitest 单测
```

> 改了 SDK 源码后要重新 `pnpm build`，示例用到的是 SDK 的 `dist/`，不是 `src/`。

## 目录说明

```
examples/react-file-browser/
├─ index.html            # Vite 入口 HTML
├─ package.json          # 依赖 baidu-drive-sdk-js: workspace:*
├─ tsconfig.json         # 自包含配置：ES2022 / Bundler / react-jsx / strict
├─ vite.config.ts        # react 插件 + panOauthCallback() 注入回调页 + dev 代理
├─ .env.example          # 只放 AppKey 占位，复制成 .env.local 使用
└─ src/
   ├─ main.tsx           # 挂载 React
   ├─ App.tsx            # 界面：登录态、面包屑、文件列表
   ├─ pan.ts             # 唯一装配点：createAuth / createOpenApi / createFileBrowse / createUserInfo
   ├─ format.ts          # 时间格式化、路径分段（有同名 .test.ts）
   └─ style.css          # 样式
```

## 几点说明

- **鉴权 token 存在浏览器 localStorage**：这是纯前端示例的取舍，方便但安全性有限。真实产品请把 token 换出到后端（`createAuth({ store })` 可以注入自己的 `CredentialStore`），不要让它停留在可被 XSS 读取的位置。
- **跨域与部署**：开放平台接口不允许浏览器直接跨域，`vite.config.ts` 里的 `/pan`、`/pcs` 代理只是 dev 期的同源转发。本示例不承诺开箱部署，上线时需要你自己准备等价的反向代理。
- **两种装配粒度**：示例按场景逐个引入（`createFileBrowse` / `createUserInfo`），演示细粒度装配；只读浏览这类场景也可以直接用 `createScene({ api, transfer })`，把所有业务方法摊平到一个对象上。

## 许可

本示例与 `baidu-drive-sdk-js` 同仓库，遵循仓库根目录的 Apache-2.0 许可。
