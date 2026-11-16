import { describe, expect, it, vi } from 'vitest';

import { createFileDownload, DownloadError } from './index';
import type { FileMetasParams, FileMetasResult } from '../../api';

const DLINK = 'https://d.pcs.baidu.com/file/abc123?fid=1-2-3&time=1&sign=x';

const found: FileMetasResult = {
  errno: 0,
  list: [
    {
      fs_id: 42,
      filename: '%E6%96%87%E4%BB%B6.txt',
      path: '/apps/x/%E6%96%87%E4%BB%B6.txt',
      size: 1024,
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      isdir: 0,
      category: 4,
      dlink: DLINK
    }
  ]
};

function makeDownload(result: FileMetasResult = found, token = 'tok-1') {
  return createFileDownload({ fileMetas: async () => result }, { getToken: () => token });
}

describe('meta', () => {
  it('dlink 拼上 access_token，文件名和路径解码', async () => {
    const info = await makeDownload().meta(42);
    expect(info.dlink).toBe(DLINK + '&access_token=tok-1');
    expect(info.filename).toBe('文件.txt');
    expect(info.path).toBe('/apps/x/文件.txt');
    expect(info.size).toBe(1024);
  });

  it('请求时带上 dlink=1，否则接口不返回下载地址', async () => {
    let seen: FileMetasParams | undefined;
    const download = createFileDownload(
      {
        fileMetas: async (params) => {
          seen = params;
          return found;
        }
      },
      { getToken: () => 't' }
    );
    await download.meta(42);
    expect(seen).toEqual({ fsids: [42], dlink: 1 });
  });

  it('没有 token 时不拼空的 access_token', async () => {
    const info = await makeDownload(found, '').meta(42);
    expect(info.dlink).toBe(DLINK);
  });
});

describe('失败分支', () => {
  it('list 为空时报 fsid 查不到', async () => {
    await expect(makeDownload({ errno: 0, list: [] }).meta(42)).rejects.toThrow(
      '没有查到这个 fsid'
    );
  });

  it('逐条 errno 非 0 时抛错，不当成功', async () => {
    const result: FileMetasResult = {
      errno: 0,
      list: [{ ...found.list[0], errno: -9 }]
    };
    await expect(makeDownload(result).meta(42)).rejects.toThrow('errno -9');
  });

  it('没有 dlink 时提示权限问题而不是返回 undefined', async () => {
    const result: FileMetasResult = {
      errno: 0,
      list: [{ ...found.list[0], dlink: undefined }]
    };
    await expect(makeDownload(result).meta(42)).rejects.toThrow('没有返回 dlink');
  });

  it('DownloadError 带得上 fsId', () => {
    expect(new DownloadError('x', 7)).toMatchObject({ name: 'DownloadError', fsId: 7 });
  });
});

describe('sameOriginUrl', () => {
  it('把 dlink 的域名换成代理前缀', () => {
    expect(makeDownload().sameOriginUrl(DLINK)).toBe('/pcs/file/abc123?fid=1-2-3&time=1&sign=x');
  });

  it('前缀可配，要和反代规则一致', () => {
    const download = createFileDownload(
      { fileMetas: async () => found },
      { getToken: () => 't', proxyPrefix: '/dl' }
    );
    expect(download.sameOriginUrl(DLINK)).toBe('/dl/file/abc123?fid=1-2-3&time=1&sign=x');
  });

  it('不认识的域名原样返回，不悄悄拼出一个错地址', () => {
    expect(makeDownload().sameOriginUrl('https://example.com/a.txt')).toBe(
      'https://example.com/a.txt'
    );
  });
});

describe('fetchBlob', () => {
  it('走同源地址而不是直连 dlink', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return { ok: true, blob: async () => new Blob(['x']) } as unknown as Response;
    });
    const blob = await makeDownload().fetchBlob(42);
    expect(calls[0].startsWith('/pcs/file/abc123')).toBe(true);
    expect(blob.size).toBe(1);
    vi.unstubAllGlobals();
  });

  it('非 2xx 时抛 DownloadError', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(makeDownload().fetchBlob(42)).rejects.toThrow('HTTP 403');
    vi.unstubAllGlobals();
  });
});

describe('saveAs', () => {
  it('没有 DOM 时给出可操作的提示', async () => {
    await expect(makeDownload().saveAs(42)).rejects.toThrow('需要 DOM');
  });
});
