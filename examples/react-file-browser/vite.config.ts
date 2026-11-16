import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { panOauthCallback } from 'baidu-drive-sdk-js/api/auth/vite';

export default defineConfig({
  plugins: [react(), panOauthCallback()],
  server: {
    port: 5175,
    proxy: {
      // 开放平台接口不支持浏览器跨域，dev 下由 Vite 做同源转发。
      // 生产部署时需要你自己准备同名的反向代理（示例不承诺开箱部署）。
      '/pan': {
        target: 'https://pan.baidu.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pan/, '')
      },
      '/pcs': {
        target: 'https://d.pcs.baidu.com',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/pcs/, '')
      }
    }
  }
});
