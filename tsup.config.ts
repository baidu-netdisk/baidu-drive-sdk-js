import { defineConfig } from 'tsup';

// 两层结构，与 Go SDK 对齐：
//   api/    与开放平台接口一一对应（transport / client / endpoints / errors / auth）
//   scene/  业务场景编排（listDir、upload、mkdirIfNotExist ...）
//
// 每个入口对应 package.json 里的一个子路径导出。
// src/api/auth/vite.mjs 是手写 JS（见该文件顶部说明），不走 tsup，
// 由 scripts/copy-static.mjs 原样拷到 dist/api/auth/。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'api/index': 'src/api/index.ts',
    'api/auth/index': 'src/api/auth/index.ts',
    'scene/index': 'src/scene/index.ts',
    'scene/file-browse/index': 'src/scene/file-browse/index.ts',
    'scene/file-manage/index': 'src/scene/file-manage/index.ts',
    'scene/file-upload/index': 'src/scene/file-upload/index.ts',
    'scene/file-download/index': 'src/scene/file-download/index.ts',
    'scene/user-info/index': 'src/scene/user-info/index.ts'
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true
});
