// vite.mjs 是手写 JS（见文件头注释说明为什么不能是 .ts），类型在这里单独声明。

export declare function callbackPageHtml(messageType?: string): string;

export interface PanOauthCallbackOptions {
  /** 产出的文件名，需与登记的 redirect_uri 路径一致，默认 oauth-callback.html */
  fileName?: string;
  messageType?: string;
  /** 应用挂载的子路径前缀（如 `/my-app/`）。默认读 Vite 的 `server.config.base`，两者都没有时按 `/` */
  base?: string;
}

export interface CallbackRequest {
  url?: string;
}

export interface CallbackResponse {
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
}

export interface CallbackDevServer {
  /** Vite 的 DevServer 配置；dev 回调页路由会跟随 base（子路径部署） */
  config?: { base?: string };
  middlewares: {
    use: (
      handler: (req: CallbackRequest, res: CallbackResponse, next: () => void) => void
    ) => void;
  };
}

export interface EmitFileContext {
  emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void;
}

export interface PanOauthCallbackPlugin {
  name: string;
  configureServer: (server: CallbackDevServer) => void;
  generateBundle: (this: EmitFileContext) => void;
}

export declare function panOauthCallback(
  options?: PanOauthCallbackOptions
): PanOauthCallbackPlugin;
