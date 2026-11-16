/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 百度网盘开放平台 AppKey（公开标识，不是密钥） */
  readonly VITE_PAN_APP_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
