import { describe, expect, it } from 'vitest';

import { BrowseTruncatedError, createFileBrowse, toBrowseFile } from './index';
import type { ListFilesParams, PanFile, SearchFilesParams } from '../../api';

function file(patch: Partial<PanFile> = {}): PanFile {
  return {
    fs_id: 1,
    path: '/a.txt',
    server_filename: 'a.txt',
    size: 10,
    isdir: 0,
    category: 4,
    server_mtime: 0,
    ...patch
  };
}

describe('文件名解码', () => {
  it('把 URL 编码的文件名和路径解出来，原始字段保留', () => {
    const raw = file({
      server_filename: '%E5%B7%A5%E5%85%B7%E9%AA%8C%E8%AF%81',
      path: '%2F%E5%B7%A5%E5%85%B7'
    });
    const browse = toBrowseFile(raw);
    expect(browse.name).toBe('工具验证');
    expect(browse.decodedPath).toBe('/工具');
    expect(browse.server_filename).toBe(raw.server_filename);
  });

  it('解码失败时退回原值，不让一个坏名字搞崩整次列目录', () => {
    const browse = toBrowseFile(file({ server_filename: '100%' }));
    expect(browse.name).toBe('100%');
  });
});

describe('listDir', () => {
  it('即便调用方只给 limit，也会自动补上 start —— 否则平台会忽略 limit', async () => {
    const seen: ListFilesParams[] = [];
    const browse = createFileBrowse({
      listFiles: async (params) => {
        seen.push(params!);
        return { errno: 0, guid_info: '', list: [file()] };
      }
    });
    await browse.listDir('/', { limit: 10 });
    expect(seen[0].start).toBe(0);
    expect(seen[0].limit).toBe(10);
  });

  it('desc 布尔值转成接口要的 0/1，未传则不下发该参数', async () => {
    const seen: ListFilesParams[] = [];
    const browse = createFileBrowse({
      listFiles: async (params) => {
        seen.push(params!);
        return { errno: 0, guid_info: '', list: [] };
      }
    });
    await browse.listDir('/', { desc: true });
    await browse.listDir('/', {});
    expect(seen[0].desc).toBe(1);
    expect(seen[1].desc).toBeUndefined();
  });

  it('onlyFolder 映射成 folder=1', async () => {
    let seen: ListFilesParams | undefined;
    const browse = createFileBrowse({
      listFiles: async (params) => {
        seen = params;
        return { errno: 0, guid_info: '', list: [] };
      }
    });
    await browse.listDir('/', { onlyFolder: true });
    expect(seen?.folder).toBe(1);
  });
});

describe('listAll', () => {
  it('一直翻页到最后一页不满为止', async () => {
    const pages = [3, 3, 1];
    const starts: Array<number | undefined> = [];
    const browse = createFileBrowse({
      listFiles: async (params) => {
        starts.push(params?.start);
        const count = pages[starts.length - 1] ?? 0;
        return { errno: 0, guid_info: '', list: Array.from({ length: count }, () => file()) };
      }
    });
    const all = await browse.listAll('/', { limit: 3 });
    expect(all).toHaveLength(7);
    expect(starts).toEqual([0, 3, 6]);
  });

  it('正好整页结束时会再请求一次确认没有下一页', async () => {
    const pages = [2, 0];
    const browse = createFileBrowse({
      listFiles: async (params) => {
        const count = pages[(params!.start ?? 0) / 2] ?? 0;
        return { errno: 0, guid_info: '', list: Array.from({ length: count }, () => file()) };
      }
    });
    expect(await browse.listAll('/', { limit: 2 })).toHaveLength(2);
  });
});

describe('search', () => {
  it('关键字下发到 key 而不是 query，默认递归', async () => {
    let seen: SearchFilesParams | undefined;
    const browse = createFileBrowse({
      searchFiles: async (params) => {
        seen = params;
        return { errno: 0, has_more: 1, list: [file()] };
      }
    });
    const result = await browse.search('合同', { category: 4 });
    expect(seen?.key).toBe('合同');
    expect(seen?.recursion).toBe(1);
    expect(seen?.category).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(result.files[0].name).toBe('a.txt');
  });

  it('recursive: false 时不下发 recursion', async () => {
    let seen: SearchFilesParams | undefined;
    const browse = createFileBrowse({
      searchFiles: async (params) => {
        seen = params;
        return { errno: 0, has_more: 0, list: [] };
      }
    });
    await browse.search('x', { recursive: false });
    expect(seen?.recursion).toBeUndefined();
  });
});

describe('listTree', () => {
  it('默认递归，靠 cursor 翻页而不是累加 start', async () => {
    const starts: Array<number | undefined> = [];
    const browse = createFileBrowse({
      listAllFiles: async (params) => {
        starts.push(params?.start);
        return starts.length === 1
          ? { errno: 0, list: [file({ path: '/a.txt' })], has_more: 1, cursor: 77 }
          : { errno: 0, list: [file({ path: '/b/c.txt' })], has_more: 0 };
      }
    });
    const files = await browse.listTree('/apps/x');
    expect(starts).toEqual([0, 77]);
    expect(files.map((f) => f.decodedPath)).toEqual(['/a.txt', '/b/c.txt']);
  });

  it('has_more 为 1 但没给 cursor 时停下，不重复拉同一页', async () => {
    let calls = 0;
    const browse = createFileBrowse({
      listAllFiles: async () => {
        calls += 1;
        return { errno: 0, list: [file()], has_more: 1 };
      }
    });
    await browse.listTree('/apps/x');
    expect(calls).toBe(1);
  });

  it('recursive: false 时 recursion 传 0', async () => {
    let seen: number | undefined;
    const browse = createFileBrowse({
      listAllFiles: async (params) => {
        seen = params?.recursion;
        return { errno: 0, list: [], has_more: 0 };
      }
    });
    await browse.listTree('/apps/x', { recursive: false });
    expect(seen).toBe(0);
  });
});

describe('分类', () => {
  it('多个分类拼成逗号分隔的字符串', async () => {
    let seen: string | undefined;
    const browse = createFileBrowse({
      categoryList: async (params) => {
        seen = params?.category;
        return { errno: 0, list: [], has_more: 0 };
      }
    });
    await browse.byCategory([1, 3]);
    expect(seen).toBe('1,3');
  });

  it('扩展名过滤也是逗号分隔', async () => {
    let seen: string | undefined;
    const browse = createFileBrowse({
      categoryList: async (params) => {
        seen = params?.ext;
        return { errno: 0, list: [], has_more: 0 };
      }
    });
    await browse.byCategory(2, { extensions: ['mp3', 'flac'] });
    expect(seen).toBe('mp3,flac');
  });

  it('categoryStats 把 info 的键转回数字分类号', async () => {
    const browse = createFileBrowse({
      categoryInfo: async () => ({ errno: 0, info: { 3: { count: 12, size: 2048 } } })
    });
    expect(await browse.categoryStats(3)).toEqual([{ category: 3, count: 12, size: 2048 }]);
  });
});

describe('媒体列表', () => {
  it('结果在 info 字段而不是 list', async () => {
    const browse = createFileBrowse({
      imageList: async () => ({ errno: 0, info: [file({ path: '/a.jpg' })] })
    });
    expect((await browse.images()).map((f) => f.decodedPath)).toEqual(['/a.jpg']);
  });

  it('用 page / num 分页，不是 start / limit', async () => {
    let seen: Record<string, unknown> | undefined;
    const browse = createFileBrowse({
      videoList: async (params) => {
        seen = params as Record<string, unknown>;
        return { errno: 0, info: [] };
      }
    });
    await browse.videos({ page: 2, num: 50 });
    expect(seen?.page).toBe(2);
    expect(seen?.num).toBe(50);
    expect('start' in (seen ?? {})).toBe(false);
  });
});

describe('searchSemantic', () => {
  it('固定 scene=mcpserver，默认搜根目录、search_type=2', async () => {
    let seen: Record<string, unknown> | undefined;
    const browse = createFileBrowse({
      uniSearch: async (params) => {
        seen = params as unknown as Record<string, unknown>;
        return { errno: 0, list: [] };
      }
    });
    await browse.searchSemantic('找去年的合同');
    expect(seen?.scene).toBe('mcpserver');
    expect(seen?.dir).toEqual(['/']);
    expect(seen?.search_type).toBe(2);
    expect(seen?.query).toBe('找去年的合同');
  });

  it('请求体固定传 {}，否则接口不接', async () => {
    let body: unknown = 'not-set';
    const browse = createFileBrowse({
      uniSearch: async (_params, options) => {
        body = options?.json;
        return { errno: 0, list: [] };
      }
    });
    await browse.searchSemantic('x');
    expect(body).toEqual({});
  });
});

describe('分页与截断（回归）', () => {
  it('onlyFolder 时平台不返回 server_filename，用路径最后一段兜底', () => {
    const raw = file({
      path: '/%E7%9B%AE%E5%BD%95',
      isdir: 1,
      server_filename: undefined as unknown as string
    });

    expect(toBrowseFile(raw).name).toBe('目录');
  });

  it('listAll 的 limit 超过平台上限时按 1000 分页，仍能取全', async () => {
    const total = 5000;
    let requests = 0;
    const browse = createFileBrowse({
      listFiles: async (params: ListFilesParams = {}) => {
        requests += 1;
        const start = params.start ?? 0;
        const size = Math.max(0, Math.min(1000, total - start));
        return {
          errno: 0,
          guid_info: '',
          list: Array.from({ length: size }, (_, index) => file({ fs_id: start + index }))
        };
      }
    });

    const all = await browse.listAll('/', { limit: 2000 });

    expect(all).toHaveLength(total);
    expect(requests).toBe(6);
  });

  it('翻页到上限时抛 BrowseTruncatedError，而不是静默返回半份数据', async () => {
    const browse = createFileBrowse({
      listFiles: async (params: ListFilesParams = {}) => ({
        errno: 0,
        guid_info: '',
        list: Array.from({ length: 1000 }, (_, index) =>
          file({ fs_id: (params.start ?? 0) + index })
        )
      })
    });

    await expect(browse.listAll('/', { maxPages: 3 })).rejects.toBeInstanceOf(BrowseTruncatedError);
  });

  it('maxPages 放宽后能继续翻到真实末尾', async () => {
    const total = 2500;
    const browse = createFileBrowse({
      listFiles: async (params: ListFilesParams = {}) => {
        const start = params.start ?? 0;
        const size = Math.max(0, Math.min(1000, total - start));
        return {
          errno: 0,
          guid_info: '',
          list: Array.from({ length: size }, (_, index) => file({ fs_id: start + index }))
        };
      }
    });

    const all = await browse.listAll('/', { maxPages: 5 });

    expect(all).toHaveLength(total);
  });

  it('listTree 翻页到上限同样抛错，不再静默截断', async () => {
    const browse = createFileBrowse({
      listAllFiles: async () => ({ errno: 0, list: [file()], has_more: 1 as const, cursor: 1 })
    });

    await expect(browse.listTree('/', { maxPages: 3 })).rejects.toBeInstanceOf(
      BrowseTruncatedError
    );
  });
});
