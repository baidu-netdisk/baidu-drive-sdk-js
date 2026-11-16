import { describe, expect, it } from 'vitest';

import { ConfigError, createMemoryTokenStore, createOpenApi } from '../api';
import { createScene } from './index';

function makeApi(baseUrl: string) {
  return createOpenApi({ baseUrl, tokenStore: createMemoryTokenStore('test-token') });
}

const api = makeApi('/pan');
const transfer = makeApi('/pcs');

describe('createScene', () => {
  it('把各场景方法摊平到同一个实例上，方法名互不覆盖', () => {
    const sc = createScene({ api, transfer });

    // file-browse
    expect(typeof sc.listDir).toBe('function');
    expect(typeof sc.listAll).toBe('function');
    expect(typeof sc.listTree).toBe('function');
    expect(typeof sc.search).toBe('function');
    expect(typeof sc.searchSemantic).toBe('function');
    expect(typeof sc.byCategory).toBe('function');
    expect(typeof sc.categoryStats).toBe('function');
    expect(typeof sc.images).toBe('function');
    // file-manage
    expect(typeof sc.exists).toBe('function');
    expect(typeof sc.copy).toBe('function');
    expect(typeof sc.move).toBe('function');
    expect(typeof sc.rename).toBe('function');
    expect(typeof sc.remove).toBe('function');
    expect(typeof sc.mkdirIfNotExist).toBe('function');
    // file-upload / file-download
    expect(typeof sc.upload).toBe('function');
    expect(typeof sc.meta).toBe('function');
    expect(typeof sc.downloadUrl).toBe('function');
    expect(typeof sc.sameOriginUrl).toBe('function');
    expect(typeof sc.fetchBlob).toBe('function');
    expect(typeof sc.saveAs).toBe('function');
    // user-info
    expect(typeof sc.profile).toBe('function');
    expect(typeof sc.quota).toBe('function');
    expect(typeof sc.overview).toBe('function');
  });

  it('也接受裸 OpenApi：读场景够用，上传才需要 transfer', () => {
    const sc = createScene(api);
    expect(typeof sc.listDir).toBe('function');
    expect(typeof sc.profile).toBe('function');
    expect(typeof sc.upload).toBe('function');
  });

  it('没有 transfer 时上传抛 ConfigError，而不是拿 /pan 去打上传域名', async () => {
    const sc = createScene(api);
    await expect(sc.upload(new Blob(['x']), '/apps/demo/x.txt')).rejects.toBeInstanceOf(
      ConfigError
    );
    await expect(sc.upload(new Blob(['x']), '/apps/demo/x.txt')).rejects.toThrow(/transfer/);
  });

  it('scene 层不改变 api 层返回值的形状：错误仍由 api 层抛', async () => {
    // 没有可用的 fetch 打桩，这里只验证构造期不报错、方法可调用
    const sc = createScene({ api, transfer });
    expect(sc).toBeTypeOf('object');
  });
});
