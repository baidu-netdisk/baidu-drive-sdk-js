// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { callbackPageHtml, panOauthCallback } from './vite.mjs';
import { OAUTH_MESSAGE_TYPE, OAUTH_RESULT_PREFIX } from './oauth';
import type { CallbackRequest, CallbackResponse } from './vite.mjs';

describe('回调页与 vite 插件', () => {
  // vite.mjs 是手写 JS，message type 在那边是字面量，这条断言防止它和 oauth.ts 漂移
  it('回调页的 message type 与 oauth.ts 保持一致', () => {
    expect(callbackPageHtml()).toContain(JSON.stringify(OAUTH_MESSAGE_TYPE));
  });

  it('回调页同时读 query 和 fragment，并认 oauth_token 这个 key', () => {
    const html = callbackPageHtml();
    expect(html).toContain('location.search');
    expect(html).toContain('location.hash');
    expect(html).toContain("pick('oauth_token')");
  });

  it('回调页把结果写进 localStorage，供独立标签页回传（并保持前缀一致）', () => {
    const html = callbackPageHtml();
    expect(html).toContain('localStorage.setItem');
    expect(html).toContain(OAUTH_RESULT_PREFIX);
  });

  it('拿到 token 后擦掉地址栏，避免 token 留在历史记录里', () => {
    expect(callbackPageHtml()).toContain('history.replaceState');
  });

  it('回调页不把 token 写进页面文本', () => {
    const html = callbackPageHtml();
    expect(html).not.toContain('textContent = payload.access_token');
    expect(html).not.toContain('console.log');
  });

  it('插件在 build 时产出回调页 asset', () => {
    const emitted: Array<{ fileName: string; source: string }> = [];
    const plugin = panOauthCallback();
    plugin.generateBundle.call({
      emitFile: (file: { fileName: string; source: string }) => void emitted.push(file)
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe('oauth-callback.html');
    expect(emitted[0].source).toContain('oauth_token');
  });

  it('dev 中间件只拦回调页路径，带查询串也能命中', () => {
    const plugin = panOauthCallback();
    type Handler = (req: CallbackRequest, res: CallbackResponse, next: () => void) => void;
    let handler: Handler = () => {};
    plugin.configureServer({ middlewares: { use: (h: Handler) => void (handler = h) } });

    const hit = { headers: {} as Record<string, string>, body: '' };
    const res: CallbackResponse = {
      setHeader: (k, v) => void (hit.headers[k] = v),
      end: (body) => void (hit.body = body ?? '')
    };
    let passedThrough = false;

    handler(
      { url: '/oauth-callback.html?oauth_token=x&state=y' },
      res,
      () => void (passedThrough = true)
    );
    expect(passedThrough).toBe(false);
    expect(hit.headers['Content-Type']).toContain('text/html');
    expect(hit.body).toContain('oauth_token');

    passedThrough = false;
    handler({ url: '/index.html' }, res, () => void (passedThrough = true));
    expect(passedThrough).toBe(true);
  });

  it('配了 Vite base 时，dev 回调页路由跟随 base（子路径部署）', () => {
    const plugin = panOauthCallback();
    type Handler = (req: CallbackRequest, res: CallbackResponse, next: () => void) => void;
    let handler: Handler = () => {};
    plugin.configureServer({
      config: { base: '/file-browser/' },
      middlewares: { use: (h: Handler) => void (handler = h) }
    });

    const hit = { headers: {} as Record<string, string>, body: '' };
    const res: CallbackResponse = {
      setHeader: (k, v) => void (hit.headers[k] = v),
      end: (body) => void (hit.body = body ?? '')
    };
    let passedThrough = false;

    handler(
      { url: '/file-browser/oauth-callback.html?oauth_token=x' },
      res,
      () => void (passedThrough = true)
    );
    expect(passedThrough).toBe(false);
    expect(hit.body).toContain('oauth_token');

    passedThrough = false;
    handler({ url: '/other.html' }, res, () => void (passedThrough = true));
    expect(passedThrough).toBe(true);
  });

  it('显式 base 参数优先于 Vite 配置（非 Vite 场景）', () => {
    const plugin = panOauthCallback({ base: '/sub/' });
    type Handler = (req: CallbackRequest, res: CallbackResponse, next: () => void) => void;
    let handler: Handler = () => {};
    plugin.configureServer({ middlewares: { use: (h: Handler) => void (handler = h) } });

    const hit = { headers: {} as Record<string, string>, body: '' };
    const res: CallbackResponse = {
      setHeader: (k, v) => void (hit.headers[k] = v),
      end: (body) => void (hit.body = body ?? '')
    };
    let passedThrough = false;

    handler({ url: '/sub/oauth-callback.html' }, res, () => void (passedThrough = true));
    expect(passedThrough).toBe(false);
    expect(hit.body).toContain('oauth_token');
  });

  it('文件名可配置，便于 app 部署在子路径下', () => {
    const emitted: string[] = [];
    panOauthCallback({ fileName: 'cb.html' }).generateBundle.call({
      emitFile: (file: { fileName: string }) => void emitted.push(file.fileName)
    });
    expect(emitted).toEqual(['cb.html']);
  });
});
