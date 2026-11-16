/** 网盘 server_mtime（Unix 秒）转可读本地时间 */
export function formatTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '-';
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** 去掉首尾 / 的目录分段，用于面包屑 */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}
