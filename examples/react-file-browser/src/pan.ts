// 装配点：只在这里把「授权」和「请求」接起来，页面里直接 import 用。
//
// 简化模式（implicit）：token 由百度直接带回 /oauth-callback.html（panOauthCallback() 生成），
// 不需要 SecretKey、不需要后端换 code。

import { createAuth } from 'baidu-drive-sdk-js/api/auth';
import { createFileBrowse } from 'baidu-drive-sdk-js/scene/file-browse';
import { createOpenApi } from 'baidu-drive-sdk-js/api';
import { createUserInfo } from 'baidu-drive-sdk-js/scene/user-info';
import { ApiError, HttpError } from 'baidu-drive-sdk-js/api';
import type { Auth } from 'baidu-drive-sdk-js/api/auth';
import type { FileBrowse } from 'baidu-drive-sdk-js/scene/file-browse';
import type { OpenApi } from 'baidu-drive-sdk-js/api';
import type { UserInfo } from 'baidu-drive-sdk-js/scene/user-info';

/** 简化模式回调页，由 baidu-drive-sdk-js/api/auth/vite 插件在 dev 与 build 时产出 */
export const REDIRECT_PATH = '/oauth-callback.html';

let authInstance: Auth | null = null;
let apiInstance: OpenApi | null = null;
let browseInstance: FileBrowse | null = null;
let userInfoInstance: UserInfo | null = null;

function readAppKey(): string {
  return (import.meta.env.VITE_PAN_APP_KEY ?? '').trim();
}

export function isPanConfigured(): boolean {
  return readAppKey() !== '';
}

export function getAuth(): Auth {
  if (authInstance === null) {
    const appKey = readAppKey();
    if (appKey === '') {
      throw new Error('未配置 VITE_PAN_APP_KEY，无法登录网盘；请复制 .env.example 为 .env.local 并填入 AppKey');
    }
    // mode: tab —— 新标签页整页授权，复用浏览器已有百度登录态，不会被弹窗拦截
    authInstance = createAuth({
      appKey,
      redirectUri: window.location.origin + REDIRECT_PATH,
      mode: 'tab'
    });
  }
  return authInstance;
}

function getApi(): OpenApi {
  if (apiInstance === null) apiInstance = createOpenApi({ tokenStore: getAuth().tokenStore });
  return apiInstance;
}

export function getBrowse(): FileBrowse {
  if (browseInstance === null) browseInstance = createFileBrowse(getApi());
  return browseInstance;
}

export function getUserInfoService(): UserInfo {
  if (userInfoInstance === null) userInfoInstance = createUserInfo(getApi());
  return userInfoInstance;
}

/** 把网盘错误翻译成一句人话。errno 文案表在 baidu-drive-sdk-js/api 里统一维护。 */
export function describePanError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof HttpError) {
    if (error.kind === 'network') return '网络请求失败，检查网络后重试';
    if (error.kind === 'timeout') return '请求超时，稍后重试';
    return '网盘接口请求失败：' + error.message;
  }
  if (error instanceof Error) return error.message;
  return '未知错误';
}
