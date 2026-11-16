// 对构建产物做一次冒烟检查：所有 exports 子路径都能被 Node 解析，
// 关键工厂函数能构造出实例。防止「类型检查过了、但 exports 映射写错」这类问题进主干。
//
// 只依赖 Node 内置能力，所以 CI 里 build 之后直接跑，不需要额外装东西。
import assert from 'node:assert/strict';

const subpaths = [
  'baidu-drive-sdk-js',
  'baidu-drive-sdk-js/api',
  'baidu-drive-sdk-js/api/auth',
  'baidu-drive-sdk-js/api/auth/vite',
  'baidu-drive-sdk-js/scene',
  'baidu-drive-sdk-js/scene/file-browse',
  'baidu-drive-sdk-js/scene/file-manage',
  'baidu-drive-sdk-js/scene/file-upload',
  'baidu-drive-sdk-js/scene/file-download',
  'baidu-drive-sdk-js/scene/user-info'
];

for (const specifier of subpaths) {
  const mod = await import(specifier);
  assert.ok(Object.keys(mod).length > 0, `${specifier} 没有导出任何东西`);
  console.log('ok', specifier, `(${Object.keys(mod).length} exports)`);
}

const root = await import('baidu-drive-sdk-js');
const apiLayer = await import('baidu-drive-sdk-js/api');
const auth = await import('baidu-drive-sdk-js/api/auth');
const vite = await import('baidu-drive-sdk-js/api/auth/vite');
const scene = await import('baidu-drive-sdk-js/scene');
const browse = await import('baidu-drive-sdk-js/scene/file-browse');
const manage = await import('baidu-drive-sdk-js/scene/file-manage');
const user = await import('baidu-drive-sdk-js/scene/user-info');
const download = await import('baidu-drive-sdk-js/scene/file-download');
const upload = await import('baidu-drive-sdk-js/scene/file-upload');

const tokenStore = apiLayer.createMemoryTokenStore('smoke-test-token');
const api = apiLayer.createOpenApi({ tokenStore, baseUrl: '/pan' });
const transfer = apiLayer.createOpenApi({ tokenStore, baseUrl: '/pcs' });

// api 层
assert.equal(typeof api.defineApi, 'function');
assert.equal(typeof apiLayer.withRetry, 'function');
assert.equal(apiLayer.DEFAULT_BASE_URL, '/pan');
assert.equal(apiLayer.errnoMessage(-6), '身份验证失败，请重新授权');
assert.equal(apiLayer.needsReauth(-6), true);
assert.equal(apiLayer.Errno.AccessTokenExpired, 20016);
assert.equal(apiLayer.Errno.PathNotExist, -9);
assert.equal(apiLayer.isErrno(new Error('boom'), apiLayer.Errno.PathNotExist), false);
assert.equal(typeof auth.createAuth, 'function');
assert.equal(vite.panOauthCallback().name, 'pan-oauth-callback');

// scene 层：各场景工厂 + 聚合实例
assert.equal(typeof browse.createFileBrowse(api).listDir, 'function');
assert.equal(typeof manage.createFileManage(api).mkdirIfNotExist, 'function');
assert.equal(typeof user.createUserInfo(api).overview, 'function');
assert.equal(typeof download.createFileDownload(api).saveAs, 'function');
assert.equal(typeof upload.createFileUpload({ api, upload: transfer }).upload, 'function');
const sc = scene.createScene({ api, transfer });
for (const method of ['listDir', 'search', 'exists', 'copy', 'upload', 'saveAs', 'profile']) {
  assert.equal(typeof sc[method], 'function', `scene.${method} 缺失`);
}

// 聚合入口与派生工具
assert.equal(typeof root.createScene, 'function');
assert.equal(user.formatBytes(1536), '1.5 KB');
assert.equal(await upload.md5OfBlob(new Blob(['hello'])), '5d41402abc4b2a76b9719d911017c592');

// 缺 transfer 时上传要给出可读的配置错误，而不是拿去打 /pan
const readOnlyScene = scene.createScene(api);
await assert.rejects(readOnlyScene.upload(new Blob(['x']), '/apps/demo/x.txt'), /transfer/);

console.log('\nsmoke test passed:', subpaths.length, 'subpaths');
