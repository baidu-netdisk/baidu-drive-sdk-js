import { describe, expect, it } from 'vitest';

import { createUserInfo, formatBytes, vipLabel } from './index';
import type { PanUserInfo, QuotaParams, QuotaResult } from '../../api';

const me: PanUserInfo = {
  baidu_name: 'baidu-a001',
  netdisk_name: 'netdiskuser',
  avatar_url: 'https://example.com/a.jpg',
  vip_type: 2,
  uk: 123456
};

const space: QuotaResult = {
  errno: 0,
  total: 2199023255552,
  used: 1099511627776,
  free: 1073741824,
  expire: true
};

describe('profile', () => {
  it('字段转成驼峰，vip_type 翻成中文', async () => {
    const user = createUserInfo({ userInfo: async () => me });
    expect(await user.profile()).toEqual({
      baiduName: 'baidu-a001',
      netdiskName: 'netdiskuser',
      displayName: 'netdiskuser',
      avatarUrl: 'https://example.com/a.jpg',
      uk: 123456,
      vipType: 2,
      vipLabel: '超级会员',
      isVip: true
    });
  });

  // 实测 netdisk_name 会是空串，文档没写这种情况
  it('netdisk_name 为空串时 displayName 回退 baidu_name', async () => {
    const user = createUserInfo({ userInfo: async () => ({ ...me, netdisk_name: '' }) });
    const profile = await user.profile();
    expect(profile.netdiskName).toBe('');
    expect(profile.displayName).toBe('baidu-a001');
  });

  it('两个名字都为空时 displayName 用 uk 兜底', async () => {
    const user = createUserInfo({
      userInfo: async () => ({ ...me, netdisk_name: '', baidu_name: '' })
    });
    expect((await user.profile()).displayName).toBe('用户 123456');
  });

  it('未知 vip_type 不崩，带上原值', () => {
    expect(vipLabel(9)).toBe('未知会员类型 9');
  });
});

describe('quota', () => {
  it('固定带上 checkfree 和 checkexpire', async () => {
    let seen: QuotaParams | undefined;
    const user = createUserInfo({
      quota: async (params) => {
        seen = params;
        return space;
      }
    });
    await user.quota();
    expect(seen).toEqual({ checkfree: 1, checkexpire: 1 });
  });

  it('补出接口不给的 available 和 usedRatio', async () => {
    const user = createUserInfo({ quota: async () => space });
    const result = await user.quota();
    expect(result.available).toBe(1099511627776);
    expect(result.usedRatio).toBeCloseTo(0.5);
    expect(result.expiring).toBe(true);
  });

  it('free 原样带出，不参与可用空间计算', async () => {
    const user = createUserInfo({ quota: async () => space });
    const result = await user.quota();
    // free 是免费容量，和 available 没关系
    expect(result.free).toBe(1073741824);
    expect(result.available).not.toBe(result.free);
  });

  it('total 为 0 时占比是 0 而不是 NaN', async () => {
    const user = createUserInfo({ quota: async () => ({ errno: 0, total: 0, used: 0 }) });
    const result = await user.quota();
    expect(result.usedRatio).toBe(0);
    expect(result.available).toBe(0);
  });

  it('used 超过 total 时可用空间按 0 算，不出负数', async () => {
    const user = createUserInfo({ quota: async () => ({ errno: 0, total: 100, used: 150 }) });
    expect((await user.quota()).available).toBe(0);
  });

  it('缺 free / expire 时退化成 0 和 false', async () => {
    const user = createUserInfo({ quota: async () => ({ errno: 0, total: 100, used: 10 }) });
    const result = await user.quota();
    expect(result.free).toBe(0);
    expect(result.expiring).toBe(false);
  });
});

describe('overview', () => {
  it('两个接口都调到，结果合在一起', async () => {
    const called: string[] = [];
    const user = createUserInfo({
      userInfo: async () => {
        called.push('uinfo');
        return me;
      },
      quota: async () => {
        called.push('quota');
        return space;
      }
    });
    const result = await user.overview();
    expect(called.sort()).toEqual(['quota', 'uinfo']);
    expect(result.profile.netdiskName).toBe('netdiskuser');
    expect(result.quota.total).toBe(2199023255552);
  });

  it('没传到的端点被调用时报出缺哪个', async () => {
    const user = createUserInfo({ userInfo: async () => me });
    await expect(user.quota()).rejects.toThrow('缺少端点实现：quota');
  });
});

describe('formatBytes', () => {
  it('按 1024 进位，字节不带小数', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1099511627776)).toBe('1.0 TB');
  });

  it('非法输入返回占位符而不是 NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(-1)).toBe('-');
  });
});
