// 刻意用 .mjs 而不是 .ts：这个文件被 app 的 vite.config.ts 引用，
// 而 vite 加载配置时会把 node_modules 里的依赖当成 external 交给 Node，
// Node 加载不了裸 .ts（ERR_UNKNOWN_FILE_EXTENSION）。写成 .mjs 就能直接被引用，
// 也不用给 auth 模块加编译步骤。
//
// 这里的 'baidu_pan_oauth_result' 必须和 src/oauth.ts 的 OAUTH_MESSAGE_TYPE 一致，
// src/vite.test.ts 有断言守着，改一处另一处会红。

const DEFAULT_MESSAGE_TYPE = 'baidu_pan_oauth_result';

export function callbackPageHtml(messageType = DEFAULT_MESSAGE_TYPE) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>授权回调</title>
</head>
<body>
  <p id="msg" style="font-family:-apple-system,sans-serif;text-align:center;margin-top:80px;color:#555">正在回传授权结果…</p>
  <script>
    // token 回调的 key 是 oauth_token，不是 access_token。
    // 标准 implicit 回在 #fragment，但 pan.baidu.com/union/oauth/authorize 实测可能回在 ?query，
    // 所以两处都取。它是凭据：别写进页面、别 console；回在 query 时还会进访问日志，只能靠擦地址栏兜。
    // 失败有两种形态：用户取消是 error=access_denied，平台侧失败是 errno/errmsg，都要原样带回去。
    (function () {
      var q = new URLSearchParams(location.search);
      var hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      function pick(key) { return q.get(key) || hash.get(key) || ''; }
      var payload = {
        type: ${JSON.stringify(messageType)},
        access_token: pick('oauth_token') || pick('access_token'),
        expires_in: pick('expires_in'),
        state: pick('state'),
        error: pick('error'),
        error_description: pick('error_description'),
        errno: pick('errno'),
        errmsg: pick('errmsg'),
      };
      // 写一份到 localStorage：开在独立标签页、或浏览器把 opener 断掉时，主页面靠 storage 事件拿结果
      try {
        if (payload.state) localStorage.setItem('baidu_pan_oauth_result:' + payload.state, JSON.stringify(payload));
      } catch (e) {}
      try { if (window.opener) window.opener.postMessage(payload, location.origin); } catch (e) {}
      var ok = payload.access_token;
      // token 会留进地址栏与历史记录（union 页回在 query），回传完立刻擦掉
      if (ok) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
      document.getElementById('msg').textContent = ok
        ? '授权成功，正在返回…'
        : ('授权失败：' + (payload.error_description || payload.errmsg || payload.error || '未获取到授权结果'));
      if (ok) setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
    })();
  </script>
</body>
</html>
`;
}

/**
 * 把授权回调页注入到 app：dev 下由中间件提供，build 时作为 asset 产出。
 * 源只有这一份，各 app 一行接入：
 *
 *   import { panOauthCallback } from 'baidu-drive-sdk-js/api/auth/vite';
 *   export default defineConfig({ plugins: [react(), panOauthCallback()] });
 */
export function panOauthCallback(options = {}) {
  const fileName = options.fileName ?? 'oauth-callback.html';
  const html = callbackPageHtml(options.messageType);

  return {
    name: 'pan-oauth-callback',
    configureServer(server) {
      // 应用可能挂在子路径下（Vite base，如 /file-browser/），回调页路由要跟着 base 走。
      // 优先级：显式 options.base > Vite 的 server.config.base > '/'。
      // 同时保留根路径匹配：个别 Vite 版本会在用户中间件之前剥掉 base。
      const configured = options.base ?? server?.config?.base ?? '/';
      const base = configured.endsWith('/') ? configured.slice(0, -1) : configured;
      const route = base + '/' + fileName;

      server.middlewares.use((req, res, next) => {
        // 带查询串时 req.url 形如 /<base>/oauth-callback.html?oauth_token=...
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname !== route && pathname !== '/' + fileName) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: html });
    }
  };
}
