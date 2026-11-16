// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { createAuth } from './index';
import {
  createLocalCredentialStore,
  createMemoryCredentialStore,
  credentialStoreKey,
  credentialUsable
} from './credential';
import { OAUTH_MESSAGE_TYPE } from './oauth';
import type { Credential } from './credential';

const CONFIG = {
  appKey: 'app-1',
  redirectUri: 'https://a.example.com/oauth-callback.html',
  scope: 'basic,netdisk'
};

function credential(patch: Partial<Credential> = {}): Credential {
  return {
    accessToken: 'tok',
    refreshToken: '',
    expiresAt: Date.now() + 3600_000,
    requestedScope: CONFIG.scope,
    ...patch
  };
}

describe('凭据缓存', () => {
  it('存储 key 按 appKey、回调地址和 scope 三者隔离', () => {
    const base = credentialStoreKey('app-1', 'https://a/cb', 'basic');
    expect(base).toMatch(/^pan-oauth-v1-/);
    expect(credentialStoreKey('app-2', 'https://a/cb', 'basic')).not.toBe(base);
    expect(credentialStoreKey('app-1', 'https://b/cb', 'basic')).not.toBe(base);
    expect(credentialStoreKey('app-1', 'https://a/cb', 'basic,netdisk')).not.toBe(base);
  });

  it('损坏的数据和版本不匹配都返回 null，且不碰其他 localStorage 键', () => {
    const store = createLocalCredentialStore();
    localStorage.setItem('other', 'value');
    localStorage.setItem('broken', 'not-json');
    localStorage.setItem('wrong-version', JSON.stringify({ version: 9, credential: credential() }));
    expect(store.load('broken')).toBeNull();
    expect(store.load('wrong-version')).toBeNull();
    expect(store.load('missing')).toBeNull();
    expect(localStorage.getItem('other')).toBe('value');
  });

  it('scope 不足或临近过期时不复用', () => {
    const now = 1_700_000_000_000;
    expect(credentialUsable(credential({ expiresAt: now + 6 * 60_000 }), 'basic', now)).toBe(true);
    expect(credentialUsable(credential({ expiresAt: now + 4 * 60_000 }), 'basic', now)).toBe(false);
    expect(credentialUsable(credential({ requestedScope: 'basic' }), 'basic,netdisk')).toBe(false);
    expect(credentialUsable(null, 'basic')).toBe(false);
  });
});

describe('createAuth', () => {
  it('手填 token 可保存并被复用，不会拉起弹窗', async () => {
    const auth = createAuth({ ...CONFIG, store: createMemoryCredentialStore() });
    auth.saveManualToken('pasted-token');
    const session = auth.begin();
    expect(session.oauth).toBeNull();
    const result = await auth.wait(session);
    expect(result.fromStore).toBe(true);
    expect(result.credential.accessToken).toBe('pasted-token');
  });

  it('无可用凭据时创建授权会话', () => {
    const auth = createAuth({ ...CONFIG, store: createMemoryCredentialStore() });
    const session = auth.begin();
    const url = new URL(session.oauth!.authorizationURL);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.appKey);
    expect(url.searchParams.get('response_type')).toBe('token');
  });

  it('wait 是单次语义', async () => {
    const auth = createAuth({ ...CONFIG, store: createMemoryCredentialStore() });
    auth.saveManualToken('tok');
    const session = auth.begin();
    await auth.wait(session);
    await expect(auth.wait(session)).rejects.toThrow('已被使用');
  });

  it('tokenStore 在凭据过期时返回空串，logout 后也为空', () => {
    const store = createMemoryCredentialStore();
    const auth = createAuth({ ...CONFIG, store });
    auth.saveManualToken('tok');
    expect(auth.tokenStore.get()).toBe('tok');

    const key = credentialStoreKey(CONFIG.appKey, CONFIG.redirectUri, CONFIG.scope);
    store.save(key, credential({ expiresAt: Date.now() - 1000 }));
    expect(auth.tokenStore.get()).toBe('');

    auth.saveManualToken('tok2');
    auth.logout();
    expect(auth.tokenStore.get()).toBe('');
    expect(auth.load()).toBeNull();
  });

  it('真实授权成功后把凭据写进 store，并算出过期时间', async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const auth = createAuth({ ...CONFIG, store: createMemoryCredentialStore() });
    const session = auth.begin();
    const pending = auth.wait(session);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: OAUTH_MESSAGE_TYPE,
          access_token: 'fresh-token',
          expires_in: '2592000',
          state: session.oauth!.state
        },
        origin: window.location.origin,
        source: popup
      })
    );
    const result = await pending;
    expect(result.fromStore).toBe(false);
    expect(result.credential.accessToken).toBe('fresh-token');
    expect(result.credential.expiresAt).toBeGreaterThan(Date.now());
    expect(auth.tokenStore.get()).toBe('fresh-token');
  });
});
