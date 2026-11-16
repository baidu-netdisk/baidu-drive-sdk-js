// 百度网盘开放平台授权（简化模式 / implicit）。
// 简化模式不需要 SecretKey，这正是它适合纯前端的原因；代价是拿不到 refresh_token，
// 过期后只能重新授权。授权码模式换 token 必须带 client_secret，只能放在服务端。

const MAX_PARAM_LEN = 4096;
const MAX_EXPIRES_IN_SEC = 100 * 366 * 24 * 3600;
const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;
const BASE64_PAD = /=+$/;

export const DEFAULT_AUTHORIZE_URL = 'https://pan.baidu.com/union/oauth/authorize';
export const DEFAULT_SCOPE = 'basic,netdisk';
export const OAUTH_MESSAGE_TYPE = 'baidu_pan_oauth_result';

/** 授权页的打开方式：popup 小窗（默认）或 tab 新标签页（整页授权，浏览器里的百度登录态更稳） */
export type OauthMode = 'popup' | 'tab';

/** 新标签页模式下，回调页把结果写进 localStorage，key 前缀与 state 拼接 */
export const OAUTH_RESULT_PREFIX = 'baidu_pan_oauth_result:';

/** 等用户授权的最长时间：超过就当作放弃，避免 Promise 永远挂着 */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export function resultKeyOf(state: string): string {
  return OAUTH_RESULT_PREFIX + state;
}

export interface OauthConfig {
  /** 该 app 在开放平台注册拿到的 AppKey，公开信息，可以提交 */
  appKey: string;
  /** 必须和控制台登记的回调地址完全一致，不一致时平台只会返回很模糊的错误 */
  redirectUri: string;
  scope?: string;
  authorizeUrl?: string;
  /** 打开授权页的方式，默认 popup；tab 会开一个新标签页（display=page） */
  mode?: OauthMode;
}

export interface OauthSession {
  authorizationURL: string;
  redirectUri: string;
  state: string;
  mode: OauthMode;
}

export interface OauthToken {
  accessToken: string;
  expiresIn: number;
}

interface CallbackPayload {
  type?: string;
  access_token?: string;
  expires_in?: string;
  state?: string;
  error?: string;
  error_description?: string;
  errno?: string;
  errmsg?: string;
}

export function randomURLSafe(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(BASE64_PLUS, '-').replace(BASE64_SLASH, '_').replace(BASE64_PAD, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function beginOauth(config: OauthConfig): OauthSession {
  const state = randomURLSafe();
  const mode: OauthMode = config.mode ?? 'popup';
  const query = new URLSearchParams({
    client_id: config.appKey,
    redirect_uri: config.redirectUri,
    response_type: 'token',
    scope: config.scope ?? DEFAULT_SCOPE,
    state,
    // 整页授权用 page，小窗用 popup；百度在整页模式下能直接复用浏览器里已有的登录态
    display: mode === 'tab' ? 'page' : 'popup'
  });
  return {
    authorizationURL: (config.authorizeUrl ?? DEFAULT_AUTHORIZE_URL) + '?' + query.toString(),
    redirectUri: config.redirectUri,
    state,
    mode
  };
}

function verifyCallback(payload: CallbackPayload, expectedState: string): OauthToken {
  const accessToken = (payload.access_token || '').trim();
  const expiresIn = (payload.expires_in || '').trim();
  const state = (payload.state || '').trim();
  const errorDesc = (payload.error_description || '').trim();
  const errno = (payload.errno || '').trim();
  const errmsg = (payload.errmsg || '').trim();
  const errorCode =
    (payload.error || '').trim() || (errno && errno !== '0' ? 'errno=' + errno : '');

  for (const value of [accessToken, expiresIn, state, errorCode, errorDesc, errno, errmsg]) {
    if (value.length > MAX_PARAM_LEN) throw new Error('授权回调参数超长，已拒绝');
  }
  if (!timingSafeEqual(state, expectedState)) throw new Error('授权回调 state 不匹配，已拒绝');
  if (!!errorCode === !!accessToken)
    throw new Error('授权回调必须恰好包含 access_token 或 error 其一');
  if (errorCode) {
    if (payload.error === 'access_denied') throw new Error('已取消授权');
    throw new Error(errorDesc || errmsg || errorCode);
  }
  const seconds = Number(expiresIn);
  if (!(seconds > 0) || seconds > MAX_EXPIRES_IN_SEC) {
    throw new Error('授权回调 expires_in 非法 (' + seconds + ')');
  }
  return { accessToken, expiresIn: seconds };
}

export function waitOauth(session: OauthSession): Promise<OauthToken> {
  return new Promise((resolve, reject) => {
    // tab 模式不传 features，浏览器会开成新标签页；保留窗口名便于复用同一个页面
    const features = session.mode === 'tab' ? undefined : 'width=480,height=680';
    const popup = window.open(session.authorizationURL, 'baidu_pan_oauth', features);
    if (!popup) {
      reject(
        new Error(
          session.mode === 'tab'
            ? '新标签页被拦截，请允许本站打开新窗口后重试'
            : '弹窗被拦截，请允许本站弹窗后重试'
        )
      );
      return;
    }

    let done = false;
    const key = resultKeyOf(session.state);

    const timer = window.setInterval(() => {
      if (popup.closed && !done) finish(() => reject(new Error('已取消授权')));
    }, 400);

    // 兜底：浏览器丢掉 opener 时（部分环境 window.opener 为 null），回调页会把结果写进
    // localStorage，这里用 storage 事件接收；同一个 state 只处理一次
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('授权超时，请重新发起')));
    }, OAUTH_TIMEOUT_MS);

    function cleanup() {
      done = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      try {
        localStorage.removeItem(key);
      } catch {
        /* 隐私模式等场景读不到就算了 */
      }
      try {
        popup!.close();
      } catch {
        /* 标签页可能已被用户关掉 */
      }
    }

    function finish(settle: () => void) {
      cleanup();
      settle();
    }

    // 只接受同源、且确实来自我们打开的那个窗口的消息
    function onMessage(event: MessageEvent) {
      if (done || event.origin !== window.location.origin) return;
      // tab 模式下 event.source 可能为 null（浏览器迁移了窗口），此时只靠 storage 兜底
      if (event.source !== null && event.source !== popup) return;
      const payload = event.data as CallbackPayload;
      if (payload?.type !== OAUTH_MESSAGE_TYPE) return;
      settleWith(payload);
    }

    function onStorage(event: StorageEvent) {
      if (done || event.key !== key || event.newValue === null) return;
      try {
        settleWith(JSON.parse(event.newValue) as CallbackPayload);
      } catch {
        finish(() => reject(new Error('授权回调内容无法解析')));
      }
    }

    function settleWith(payload: CallbackPayload) {
      try {
        const token = verifyCallback(payload, session.state);
        finish(() => resolve(token));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('授权回调校验失败')));
      }
    }

    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
  });
}

export function authorizeOauth(config: OauthConfig): Promise<OauthToken> {
  return waitOauth(beginOauth(config));
}
