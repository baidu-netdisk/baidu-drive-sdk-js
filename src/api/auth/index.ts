import {
  createLocalCredentialStore,
  credentialStoreKey,
  credentialUsable,
  manualCredential
} from './credential';
import { beginOauth, DEFAULT_SCOPE, waitOauth } from './oauth';
import type { Credential, CredentialStore } from './credential';
import type { OauthMode, OauthSession } from './oauth';

export * from './credential';
export * from './oauth';

// 结构上满足 baidu-drive-sdk-js/api 的 TokenStore，但不 import 它，
// 这样 lib/auth 和 lib/http 之间没有包依赖。
export interface TokenStoreLike {
  get: () => string;
  set: (token: string) => void;
  clear: () => void;
}

export interface AuthConfig {
  appKey: string;
  redirectUri: string;
  scope?: string;
  store?: CredentialStore;
  authorizeUrl?: string;
  /** 授权页打开方式：popup 小窗（默认）或 tab 新标签页 */
  mode?: OauthMode;
}

export interface AuthResult {
  credential: Credential;
  /** true 表示复用了缓存，没有真的拉起授权弹窗 */
  fromStore: boolean;
}

export interface AuthSession {
  oauth: OauthSession | null;
  cached: Credential | null;
  used: boolean;
}

export interface Auth {
  /** 有可用缓存就直接返回，否则拉起授权弹窗 */
  authorize: () => Promise<AuthResult>;
  /** 分两步，便于 UI 先拿到授权链接再决定何时打开 */
  begin: () => AuthSession;
  wait: (session: AuthSession) => Promise<AuthResult>;
  load: () => Credential | null;
  /** 手填 token 的调试兜底 */
  saveManualToken: (accessToken: string) => Credential;
  logout: () => void;
  tokenStore: TokenStoreLike;
}

export function createAuth(config: AuthConfig): Auth {
  const scope = config.scope ?? DEFAULT_SCOPE;
  const store = config.store ?? createLocalCredentialStore();
  const storeKey = credentialStoreKey(config.appKey, config.redirectUri, scope);

  const load = (): Credential | null => store.load(storeKey);

  function begin(): AuthSession {
    const cached = load();
    const usable = credentialUsable(cached, scope);
    return {
      oauth: usable ? null : beginOauth({ ...config, scope }),
      cached: usable ? cached : null,
      used: false
    };
  }

  async function wait(session: AuthSession): Promise<AuthResult> {
    if (session.used) throw new Error('该授权会话已被使用，请重新发起授权');
    session.used = true;
    if (session.cached) return { credential: session.cached, fromStore: true };
    if (!session.oauth) throw new Error('授权会话无效，请重新发起授权');

    const token = await waitOauth(session.oauth);
    const credential: Credential = {
      accessToken: token.accessToken,
      refreshToken: '',
      expiresAt: Date.now() + token.expiresIn * 1000,
      requestedScope: scope
    };
    store.save(storeKey, credential);
    return { credential, fromStore: false };
  }

  function saveManualToken(accessToken: string): Credential {
    const credential = manualCredential(accessToken, scope);
    store.save(storeKey, credential);
    return credential;
  }

  return {
    authorize: () => wait(begin()),
    begin,
    wait,
    load,
    saveManualToken,
    logout: () => store.remove(storeKey),
    tokenStore: {
      // 过期或 scope 不足时返回空串，让请求层抛 ConfigError 而不是拿着废 token 去打接口
      get: () => {
        const credential = load();
        return credentialUsable(credential, scope) ? credential!.accessToken : '';
      },
      set: (token) => void saveManualToken(token),
      clear: () => store.remove(storeKey)
    }
  };
}
