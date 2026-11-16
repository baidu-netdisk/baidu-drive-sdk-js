import { describe, expect, it } from 'vitest';

import { createFileManage, FileOperationError } from './index';
import type { FileManagerParams, FileMetasResult } from '../../api';

const found: FileMetasResult = {
  errno: 0,
  list: [{ fs_id: 1, path: '/a.txt', filename: 'a.txt', isdir: 0, size: 1, category: 4 }]
};
const empty: FileMetasResult = { errno: 0, list: [] };
const ok = { errno: 0, info: [{ errno: 0, path: '/a.txt' }] };

function notExist() {
  return Object.assign(new Error('文件不存在'), { errno: -9 });
}

// method=meta 查不存在的路径实测返回 HTTP 404 + error_code 31066，业务码在 body 里
function httpNotFound() {
  return Object.assign(new Error('HTTP 404'), {
    name: 'HttpError',
    status: 404,
    body: { error_code: 31066, error_msg: 'file does not exist' }
  });
}

function outOfScope() {
  return Object.assign(new Error('该路径不在允许的访问范围内'), { errno: 20020 });
}

describe('exists', () => {
  it('errno -9 当作「不存在」而不是异常', async () => {
    const manage = createFileManage({
      fileMeta: async () => {
        throw notExist();
      }
    });
    expect(await manage.exists('/nope')).toBe(false);
  });

  it('空 list 也算不存在', async () => {
    const manage = createFileManage({ fileMeta: async () => empty });
    expect(await manage.exists('/nope')).toBe(false);
  });

  it('HTTP 404 + error_code 31066 也当作「不存在」', async () => {
    const manage = createFileManage({
      fileMeta: async () => {
        throw httpNotFound();
      }
    });
    expect(await manage.exists('/nope')).toBe(false);
  });

  it('目录的 meta 返回 400 + 31301，视为「路径存在」而不是异常', async () => {
    const manage = createFileManage({
      fileMeta: async () => {
        throw Object.assign(new Error('HTTP 400'), {
          name: 'HttpError',
          status: 400,
          body: { error_code: 31301, error_msg: 'not stream file' }
        });
      }
    });
    expect(await manage.exists('/apps/demo/相册')).toBe(true);
  });

  it('其他错误照常抛出，不被吞成 false', async () => {
    const manage = createFileManage({
      fileMeta: async () => {
        throw Object.assign(new Error('token 失效'), { errno: -6 });
      }
    });
    await expect(manage.exists('/a.txt')).rejects.toThrow('token 失效');
  });
});

describe('前置检查', () => {
  it('源文件不存在时不发出操作请求', async () => {
    let called = false;
    const manage = createFileManage({
      fileMeta: async () => empty,
      copyFiles: async () => {
        called = true;
        return ok;
      }
    });
    await expect(manage.copy('/nope', '/dest')).rejects.toThrow('源文件不存在');
    expect(called).toBe(false);
  });

  it('前置检查查不动时放行，交给平台判', async () => {
    let called = false;
    const manage = createFileManage({
      fileMeta: async () => {
        throw outOfScope();
      },
      copyFiles: async () => {
        called = true;
        return ok;
      }
    });
    await manage.copy('/应用目录外/a.txt', '/dest');
    expect(called).toBe(true);
  });

  it('skipPrecheck 可以省掉那次查询', async () => {
    let metaCalled = false;
    const manage = createFileManage({
      fileMeta: async () => {
        metaCalled = true;
        return found;
      },
      copyFiles: async () => ok
    });
    await manage.copy('/a.txt', '/dest', 'a.txt', { skipPrecheck: true });
    expect(metaCalled).toBe(false);
  });
});

describe('参数组装', () => {
  it('copy 不传新名字时沿用原文件名', async () => {
    let seen: FileManagerParams | undefined;
    const manage = createFileManage({
      fileMeta: async () => found,
      copyFiles: async (params) => {
        seen = params;
        return ok;
      }
    });
    await manage.copy('/dir/a.txt', '/dest');
    expect(seen?.filelist).toEqual([{ path: '/dir/a.txt', dest: '/dest', newname: 'a.txt' }]);
    expect(seen?.async).toBe(1);
  });

  it('rename 只下发 path 和 newname', async () => {
    let seen: FileManagerParams | undefined;
    const manage = createFileManage({
      fileMeta: async () => found,
      renameFiles: async (params) => {
        seen = params;
        return ok;
      }
    });
    await manage.rename('/a.txt', 'b.txt');
    expect(seen?.filelist).toEqual([{ path: '/a.txt', newname: 'b.txt' }]);
  });

  it('delete 的 filelist 是路径字符串数组而不是对象数组', async () => {
    let seen: FileManagerParams | undefined;
    const manage = createFileManage({
      deleteFiles: async (params) => {
        seen = params;
        return ok;
      }
    });
    await manage.remove(['/a.txt', '/b.txt']);
    expect(seen?.filelist).toEqual(['/a.txt', '/b.txt']);
  });

  it('空数组不发请求', async () => {
    let called = false;
    const manage = createFileManage({
      deleteFiles: async () => {
        called = true;
        return ok;
      }
    });
    await manage.remove([]);
    expect(called).toBe(false);
  });

  it('ondup 透传', async () => {
    let seen: FileManagerParams | undefined;
    const manage = createFileManage({
      fileMeta: async () => found,
      moveFiles: async (params) => {
        seen = params;
        return ok;
      }
    });
    await manage.move('/a.txt', '/dest', 'a.txt', { ondup: 'overwrite' });
    expect(seen?.ondup).toBe('overwrite');
  });
});

describe('逐条失败', () => {
  it('顶层 errno 为 0 但 info 里有失败时也要抛', async () => {
    const manage = createFileManage({
      fileMeta: async () => found,
      copyFiles: async () => ({ errno: 0, info: [{ errno: -7, path: '/a.txt' }] })
    });
    await expect(manage.copy('/a.txt', '/dest')).rejects.toThrow(FileOperationError);
    await expect(manage.copy('/a.txt', '/dest')).rejects.toMatchObject({
      errno: -7,
      path: '/a.txt'
    });
  });
});

describe('mkdirIfNotExist', () => {
  it('用 list 能列出来就认为目录存在，不建也不发 meta（避免 400 噪音）', async () => {
    let created = false;
    let metaCalled = false;
    const manage = createFileManage({
      fileMeta: async () => {
        metaCalled = true;
        return empty;
      },
      listFiles: async () => ({ errno: 0, guid_info: '', list: [] }),
      createFolder: async () => {
        created = true;
        return { errno: 0 };
      }
    });
    await manage.mkdirIfNotExist('/apps/demo/相册/照片');
    expect(created).toBe(false);
    expect(metaCalled).toBe(false);
  });

  it('list 报「不存在」就直接建目录', async () => {
    const seen: string[] = [];
    const manage = createFileManage({
      fileMeta: async () => empty,
      listFiles: async () => {
        throw Object.assign(new Error('不存在'), { errno: -9 });
      },
      createFolder: async () => {
        seen.push('created');
        return { errno: 0 };
      }
    });
    await manage.mkdirIfNotExist('/apps/demo/相册/照片');
    expect(seen).toEqual(['created']);
  });

  it('list 报越权（20020）时抛出，不误建目录', async () => {
    let created = false;
    const manage = createFileManage({
      fileMeta: async () => empty,
      listFiles: async () => {
        throw Object.assign(new Error('越权'), { errno: 20020 });
      },
      createFolder: async () => {
        created = true;
        return { errno: 0 };
      }
    });
    await expect(manage.mkdirIfNotExist('/apps/other/相册')).rejects.toThrow('越权');
    expect(created).toBe(false);
  });

  it('目录已存在（meta 返回 31301）时不再建，也不报错', async () => {
    let created = false;
    const manage = createFileManage({
      fileMeta: async () => {
        throw Object.assign(new Error('HTTP 400'), {
          name: 'HttpError',
          status: 400,
          body: { error_code: 31301, error_msg: 'not stream file' }
        });
      },
      createFolder: async () => {
        created = true;
        return { errno: 0 };
      }
    });
    await manage.mkdirIfNotExist('/apps/demo/相册');
    expect(created).toBe(false);
  });

  it('已存在就不建，也不报错', async () => {
    let created = false;
    const manage = createFileManage({
      fileMeta: async () => found,
      createFolder: async () => {
        created = true;
        return { errno: 0 };
      }
    });
    await manage.mkdirIfNotExist('/dir');
    expect(created).toBe(false);
  });

  it('不存在时建，isdir 固定为 1', async () => {
    let seen: { path: string; isdir: number } | undefined;
    const manage = createFileManage({
      fileMeta: async () => empty,
      createFolder: async (params) => {
        seen = params!;
        return { errno: 0 };
      }
    });
    await manage.mkdirIfNotExist('/dir');
    expect(seen).toEqual({ path: '/dir', isdir: 1 });
  });
});
