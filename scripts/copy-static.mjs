// 把手写的静态文件拷到 dist/。
//
// 只有 auth 的 vite 插件需要：它是 .mjs + 手写 .d.mts，不经过 tsup 编译。
// 这样 app 才能 `import { panOauthCallback } from 'baidu-drive-sdk-js/api/auth/vite'`——
// Vite 加载配置时把 node_modules 里的依赖交给 Node，裸 .ts 加载不了。
import { copyFile, mkdir } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = new URL('../', import.meta.url);

const files = [
  ['src/api/auth/vite.mjs', 'dist/api/auth/vite.mjs'],
  ['src/api/auth/vite.d.mts', 'dist/api/auth/vite.d.mts']
];

for (const [from, to] of files) {
  const target = new URL(to, base);
  await mkdir(new URL('.', target), { recursive: true });
  await copyFile(new URL(from, base), target);
  console.log('copied ->', to, '(from', from + ')');
}

console.log('static files ready in', root + 'dist');
