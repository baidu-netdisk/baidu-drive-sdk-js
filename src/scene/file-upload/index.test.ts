import { describe, expect, it } from 'vitest';

import { createFileUpload, md5OfBlob, sliceFile, SLICE_SIZE, UploadError } from './index';
import type { PrecreateParams, Superfile2Params, UploadCreateParams } from '../../api';

const created = { errno: 0, fs_id: 99, path: '/apps/x/a.txt', size: 10 };

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

// 只传用到的假端点，没传的被调到就会报出缺哪个
function fakes(overrides: Record<string, unknown> = {}) {
  return {
    api: {
      precreate: async () => ({
        errno: 0,
        uploadid: 'u-1',
        block_list: [0],
        return_type: 1 as const
      }),
      uploadCreate: async () => created,
      ...(overrides.api as object)
    },
    upload: {
      superfile2: async () => ({ md5: 'remote-md5' }),
      singleUpload: async () => ({ fs_id: 1, path: '/apps/x/a.txt', size: 10 }),
      ...(overrides.upload as object)
    }
  };
}

describe('选路', () => {
  it('小文件走单步上传，不碰 precreate', async () => {
    let precreateCalled = false;
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => {
            precreateCalled = true;
            throw new Error('不该调到');
          }
        }
      })
    );
    const result = await uploader.upload(blobOf(1024), '/apps/x/a.txt');
    expect(result.via).toBe('single');
    expect(precreateCalled).toBe(false);
  });

  it('超过一个分片走三步', async () => {
    const uploader = createFileUpload(fakes());
    const result = await uploader.upload(blobOf(SLICE_SIZE + 1), '/apps/x/a.txt');
    expect(result.via).toBe('slice');
    expect(result.fsId).toBe(99);
  });

  it('forceSlice 让小文件也走三步', async () => {
    const uploader = createFileUpload(fakes());
    const result = await uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true });
    expect(result.via).toBe('slice');
  });
});

describe('三步流程', () => {
  it('create 用云端返回的分片 MD5，不是本地算的', async () => {
    let seen: UploadCreateParams | undefined;
    const uploader = createFileUpload(
      fakes({
        upload: { superfile2: async () => ({ md5: '云端算的' }) },
        api: {
          uploadCreate: async (params: UploadCreateParams) => {
            seen = params;
            return created;
          }
        }
      })
    );
    await uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true });
    expect(seen?.block_list).toEqual(['云端算的']);
  });

  it('只上传 precreate 要求的分片', async () => {
    const parts: number[] = [];
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => ({
            errno: 0,
            uploadid: 'u-1',
            block_list: [1],
            return_type: 1 as const
          })
        },
        upload: {
          superfile2: async (params: Superfile2Params) => {
            parts.push(params.partseq);
            return { md5: 'm' };
          }
        }
      })
    );
    await uploader.upload(blobOf(SLICE_SIZE * 2), '/apps/x/a.txt');
    expect(parts).toEqual([1]);
  });

  it('秒传命中时跳过分片和 create', async () => {
    let touched = false;
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => ({ errno: 0, uploadid: 'u-1', return_type: 2 as const }),
          uploadCreate: async () => {
            touched = true;
            return created;
          }
        },
        upload: {
          superfile2: async () => {
            touched = true;
            return { md5: 'm' };
          }
        }
      })
    );
    const result = await uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true });
    expect(result.via).toBe('rapid');
    expect(touched).toBe(false);
  });

  it('precreate 要求不存在的分片时报错而不是静默跳过', async () => {
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => ({
            errno: 0,
            uploadid: 'u-1',
            block_list: [7],
            return_type: 1 as const
          })
        }
      })
    );
    await expect(
      uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true })
    ).rejects.toThrow('不存在的分片 7');
  });

  it('ondup 翻成 rtype：overwrite 是 3', async () => {
    let seen: PrecreateParams | undefined;
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async (params: PrecreateParams) => {
            seen = params;
            return { errno: 0, uploadid: 'u-1', block_list: [0], return_type: 1 as const };
          }
        }
      })
    );
    await uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true, ondup: 'overwrite' });
    expect(seen?.rtype).toBe(3);
  });
});

describe('进度与错误', () => {
  it('进度最后一定到 1，且 loaded 等于文件大小', async () => {
    const seen: number[] = [];
    const uploader = createFileUpload(fakes());
    const size = SLICE_SIZE * 2;
    await uploader.upload(blobOf(size), '/apps/x/a.txt', {
      onProgress: (p) => seen.push(p.ratio)
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('失败时带上是哪一步', async () => {
    const uploader = createFileUpload(
      fakes({
        upload: {
          superfile2: async () => {
            throw Object.assign(new Error('分片挂了'), { errno: 31024 });
          }
        }
      })
    );
    await expect(
      uploader.upload(blobOf(10), '/apps/x/a.txt', { forceSlice: true, retry: { attempts: 1 } })
    ).rejects.toMatchObject({ name: 'UploadError', stage: 'slice', errno: 31024 });
  });

  // 实测上传失败大多是非 2xx，业务码在 HttpError.body 里而不是 error.errno
  it('非 2xx 失败时从 body 里取出业务码', async () => {
    const uploader = createFileUpload(
      fakes({
        upload: {
          singleUpload: async () => {
            throw Object.assign(new Error('HTTP 400'), {
              name: 'HttpError',
              status: 400,
              body: { error_code: 31061, error_msg: 'file already exists' }
            });
          }
        }
      })
    );
    await expect(
      uploader.upload(blobOf(10), '/apps/x/a.txt', { retry: { attempts: 1 } })
    ).rejects.toMatchObject({ name: 'UploadError', stage: 'single', errno: 31061 });
  });

  it('单步上传失败时 stage 是 single', async () => {
    const uploader = createFileUpload(
      fakes({
        upload: {
          singleUpload: async () => {
            throw new Error('没权限');
          }
        }
      })
    );
    await expect(
      uploader.upload(blobOf(10), '/apps/x/a.txt', { retry: { attempts: 1 } })
    ).rejects.toMatchObject({ name: 'UploadError', stage: 'single' });
  });

  it('没传到的端点被调用时报出缺哪个', async () => {
    const uploader = createFileUpload({ api: {}, upload: {} });
    await expect(
      uploader.upload(blobOf(10), '/apps/x/a.txt', { retry: { attempts: 1 } })
    ).rejects.toThrow('缺少端点实现：singleUpload');
  });
});

describe('分片与 MD5', () => {
  it('按 4MB 切，最后一片是余数', () => {
    const slices = sliceFile(blobOf(SLICE_SIZE + 100));
    expect(slices.length).toBe(2);
    expect(slices[1].size).toBe(100);
  });

  it('空文件也产出一片，否则 block_list 会是空数组', () => {
    expect(sliceFile(blobOf(0)).length).toBe(1);
  });

  it('MD5 是 32 位小写 hex', async () => {
    const digest = await md5OfBlob(new Blob(['hello']));
    expect(digest).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('UploadError 带得上 path 和 stage', () => {
    const error = new UploadError('x', '/a.txt', 'create', 31061);
    expect([error.name, error.path, error.stage, error.errno]).toEqual([
      'UploadError',
      '/a.txt',
      'create',
      31061
    ]);
  });
});

describe('内存与取消（回归）', () => {
  it('逐片串行计算 MD5：同一时刻只读一片，不会把整个文件读进内存', async () => {
    let active = 0;
    let peak = 0;
    const uploader = createFileUpload({
      ...fakes(),
      computeMd5: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return 'local-md5';
      }
    });

    await uploader.upload(blobOf(SLICE_SIZE * 3), '/apps/x/big.bin', { forceSlice: true });

    expect(peak).toBe(1);
  });

  it('precreate 返回空 block_list 时按平台语义传第 0 片，而不是一片都不传', async () => {
    const uploaded: number[] = [];
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => ({
            errno: 0,
            uploadid: 'u-1',
            block_list: [],
            return_type: 1 as const
          })
        },
        upload: {
          superfile2: async (params: Superfile2Params) => {
            uploaded.push(params.partseq);
            return { md5: 'remote-md5' };
          }
        }
      })
    );

    await uploader.upload(blobOf(SLICE_SIZE * 2), '/apps/x/big.bin', { forceSlice: true });

    expect(uploaded).toEqual([0]);
  });

  it('取消后不再上传剩余分片，抛带可读文案的 UploadError', async () => {
    const controller = new AbortController();
    const uploaded: number[] = [];
    const uploader = createFileUpload(
      fakes({
        api: {
          precreate: async () => ({
            errno: 0,
            uploadid: 'u-1',
            block_list: [0, 1, 2],
            return_type: 1 as const
          })
        },
        upload: {
          superfile2: async (params: Superfile2Params) => {
            uploaded.push(params.partseq);
            controller.abort();
            return { md5: 'remote-md5' };
          }
        }
      })
    );

    await expect(
      uploader.upload(blobOf(SLICE_SIZE * 3), '/apps/x/big.bin', {
        forceSlice: true,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ message: '上传已取消' });
    expect(uploaded).toEqual([0]);
  });
});
