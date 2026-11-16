// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import {
  beginOauth,
  DEFAULT_AUTHORIZE_URL,
  OAUTH_MESSAGE_TYPE,
  OAUTH_TIMEOUT_MS,
  randomURLSafe,
  resultKeyOf,
  waitOauth
} from './oauth';

const CONFIG = {
  appKey: 'test-app-key',
  redirectUri: 'https://app.example.com/oauth-callback.html',
  scope: 'basic,netdisk'
};

function dispatchCallback(popup: Window, data: Record<string, string>) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: window.location.origin,
      source: popup
    })
  );
}

function fakePopup(): Window {
  return { closed: false, close: vi.fn() } as unknown as Window;
}

describe('开放平台授权（简化模式）', () => {
  it('授权 URL 使用传入的 appKey、回调地址和 scope，走 token 模式', () => {
    const session = beginOauth(CONFIG);
    const url = new URL(session.authorizationURL);
    expect(`${url.origin}${url.pathname}`).toBe(DEFAULT_AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.appKey);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('scope')).toBe(CONFIG.scope);
    expect(url.searchParams.get('state')).toBe(session.state);
  });

  it('state 是 crypto 随机的 base64url，每次不同', () => {
    const first = randomURLSafe();
    expect(first).toHaveLength(43);
    expect(first).toMatch(/^[\w-]+$/);
    expect(first).not.toBe(randomURLSafe());
  });

  it('校验来源和 state 后返回 token，并关闭弹窗', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const session = beginOauth(CONFIG);
    const pending = waitOauth(session);
    dispatchCallback(popup, {
      type: OAUTH_MESSAGE_TYPE,
      access_token: 'token-1',
      expires_in: '2592000',
      state: session.state
    });
    await expect(pending).resolves.toEqual({ accessToken: 'token-1', expiresIn: 2592000 });
    expect(popup.close).toHaveBeenCalled();
  });

  it('state 缺失或不匹配一律拒绝', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const pending = waitOauth(beginOauth(CONFIG));
    dispatchCallback(popup, {
      type: OAUTH_MESSAGE_TYPE,
      access_token: 'token-1',
      expires_in: '2592000'
    });
    await expect(pending).rejects.toThrow('state 不匹配');
  });

  it('非我们打开的弹窗发来的消息不予理会', async () => {
    const popup = fakePopup();
    const impostor = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const session = beginOauth(CONFIG);
    const pending = waitOauth(session);
    dispatchCallback(impostor, {
      type: OAUTH_MESSAGE_TYPE,
      access_token: 'stolen',
      expires_in: '2592000',
      state: session.state
    });
    const settled = await Promise.race([pending, Promise.resolve('still-pending')]);
    expect(settled).toBe('still-pending');
    dispatchCallback(popup, {
      type: OAUTH_MESSAGE_TYPE,
      access_token: 'token-1',
      expires_in: '2592000',
      state: session.state
    });
    await expect(pending).resolves.toMatchObject({ accessToken: 'token-1' });
  });

  it('用户取消与非法 expires_in 均拒绝', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const first = beginOauth(CONFIG);
    const denied = waitOauth(first);
    dispatchCallback(popup, {
      type: OAUTH_MESSAGE_TYPE,
      error: 'access_denied',
      state: first.state
    });
    await expect(denied).rejects.toThrow('已取消授权');

    vi.spyOn(window, 'open').mockReturnValue(popup);
    const second = beginOauth(CONFIG);
    const invalid = waitOauth(second);
    dispatchCallback(popup, {
      type: OAUTH_MESSAGE_TYPE,
      access_token: 'token-1',
      expires_in: '0',
      state: second.state
    });
    await expect(invalid).rejects.toThrow('expires_in 非法');
  });

  it('tab 模式：授权 URL 用 display=page，session 里标记 mode', () => {
    const session = beginOauth({ ...CONFIG, mode: 'tab' });
    expect(session.mode).toBe('tab');
    expect(new URL(session.authorizationURL).searchParams.get('display')).toBe('page');
  });

  it('不传 mode 时仍是 popup（不影响已有应用）', () => {
    const session = beginOauth(CONFIG);
    expect(session.mode).toBe('popup');
    expect(new URL(session.authorizationURL).searchParams.get('display')).toBe('popup');
  });

  it('tab 模式：不指定小窗尺寸，靠 localStorage 回传结果', async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const session = beginOauth({ ...CONFIG, mode: 'tab' });
    const pending = waitOauth(session);

    // 不能带 width/height，否则又变成小窗（spy 跨用例复用，取最后一次调用）
    const features = open.mock.calls[open.mock.calls.length - 1]?.[2];
    expect(String(features ?? '')).not.toContain('width=');

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: resultKeyOf(session.state),
        newValue: JSON.stringify({
          type: OAUTH_MESSAGE_TYPE,
          access_token: 'token-tab',
          expires_in: '2592000',
          state: session.state
        })
      })
    );

    await expect(pending).resolves.toEqual({ accessToken: 'token-tab', expiresIn: 2592000 });
    expect(popup.close).toHaveBeenCalled();
  });

  it('tab 模式下 storage 里 state 不匹配也会拒绝', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const session = beginOauth({ ...CONFIG, mode: 'tab' });
    const pending = waitOauth(session);

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: resultKeyOf(session.state),
        newValue: JSON.stringify({
          type: OAUTH_MESSAGE_TYPE,
          access_token: 'stolen',
          expires_in: '2592000',
          state: 'another-state'
        })
      })
    );

    await expect(pending).rejects.toThrow('state 不匹配');
  });

  it('一直没授权回来时超时拒绝，不会永远挂着', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window, 'open').mockReturnValue(fakePopup());
      const pending = waitOauth(beginOauth({ ...CONFIG, mode: 'tab' }));
      const assertion = expect(pending).rejects.toThrow('授权超时');
      await vi.advanceTimersByTimeAsync(OAUTH_TIMEOUT_MS + 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('弹窗被拦截时直接失败', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(waitOauth(beginOauth(CONFIG))).rejects.toThrow('弹窗被拦截');
  });
});
