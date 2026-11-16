import { describe, expect, it } from 'vitest';
import { formatTime, segmentsOf } from './format';

describe('formatTime', () => {
  it('0 / 负数 / 非法值返回 -', () => {
    expect(formatTime(0)).toBe('-');
    expect(formatTime(-1)).toBe('-');
    expect(formatTime(Number.NaN)).toBe('-');
  });

  it('正数 Unix 秒转成可读本地时间', () => {
    const out = formatTime(1_700_000_000);
    expect(out).not.toBe('-');
    expect(out).toContain('2023');
  });
});

describe('segmentsOf', () => {
  it('根目录返回空数组', () => {
    expect(segmentsOf('/')).toEqual([]);
  });

  it('去掉首尾斜杠并分段', () => {
    expect(segmentsOf('/a/b/c')).toEqual(['a', 'b', 'c']);
    expect(segmentsOf('a/b/')).toEqual(['a', 'b']);
  });
});
