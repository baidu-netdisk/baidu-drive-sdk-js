// 账号信息场景。只做编排，端点描述在 baidu-drive-sdk-js/api。
//
// 相对直接调端点，这一层多做四件事：
// 1. quota 自动带上 checkfree / checkexpire —— 这两个默认是 0，不传就没有 free 和 expire
// 2. 补出接口不给的「剩余可用空间」和占比 —— free 字段是免费容量，不是剩余空间
// 3. vip_type 翻成可直接渲染的中文
// 4. overview 把两个接口并发取回，页头那种「头像 + 已用/总量」一次拿齐

import { QUOTA, USER_INFO, withRetry } from '../../api';
import type { OpenApi, PanUserInfo, QuotaParams, QuotaResult, RetryOptions } from '../../api';

export interface UserProfile {
  /** 百度账号名 */
  baiduName: string;
  /** 网盘账号名。实测可能是空串，渲染不要直接用它 */
  netdiskName: string;
  /** 用于渲染的名字，netdiskName 空了就回退 baiduName */
  displayName: string;
  avatarUrl: string;
  /** 用户 ID */
  uk: number;
  vipType: number;
  /** vipType 的中文说明，可直接渲染 */
  vipLabel: string;
  isVip: boolean;
}

export interface QuotaInfo {
  /** 总空间，字节 */
  total: number;
  /** 已用空间，字节 */
  used: number;
  /** 剩余可用空间，字节。接口不给，是 total - used 算出来的 */
  available: number;
  /** 已用占比 0~1，total 为 0 时是 0 */
  usedRatio: number;
  /** 接口的 free 字段：免费容量。不是剩余空间，别拿来当可用量显示 */
  free: number;
  /** 7 天内是否有容量到期 */
  expiring: boolean;
}

export interface UserOverview {
  profile: UserProfile;
  quota: QuotaInfo;
}

export interface UserInfoOptions {
  retry?: RetryOptions;
}

// 文档的旧含义。指定 vip_version=v2 时 1/2 的叫法会变成 VIP / SVIP，
// 本包不传这个参数，所以用旧含义。
const VIP_LABELS = ['普通用户', '普通会员', '超级会员'];

export function vipLabel(vipType: number): string {
  return VIP_LABELS[vipType] ?? '未知会员类型 ' + vipType;
}

/** 字节转可读文本，用于「已用 1.2 GB / 共 2 TB」这种展示 */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节数不带小数，否则「512.0 B」很怪
  return (unit === 0 ? String(value) : value.toFixed(fractionDigits)) + ' ' + units[unit];
}

// 实测 netdisk_name 可能是空串（账号 demo_user 就是），baidu_name 才有值。
// 文档没写这种情况，照着「展示用 netdisk_name」写出来就是一个空白的用户名。
function displayNameOf(raw: PanUserInfo): string {
  return raw.netdisk_name || raw.baidu_name || '用户 ' + raw.uk;
}

export function toProfile(raw: PanUserInfo): UserProfile {
  return {
    baiduName: raw.baidu_name,
    netdiskName: raw.netdisk_name,
    displayName: displayNameOf(raw),
    avatarUrl: raw.avatar_url,
    uk: raw.uk,
    vipType: raw.vip_type,
    vipLabel: vipLabel(raw.vip_type),
    isVip: raw.vip_type > 0
  };
}

export function toQuota(raw: QuotaResult): QuotaInfo {
  const total = raw.total ?? 0;
  const used = raw.used ?? 0;
  return {
    total,
    used,
    available: Math.max(total - used, 0),
    usedRatio: total > 0 ? used / total : 0,
    free: raw.free ?? 0,
    expiring: raw.expire === true
  };
}

function missing(name: string) {
  return (): never => {
    throw new Error('createUserInfo 缺少端点实现：' + name);
  };
}

export interface UserInfoDeps {
  userInfo: (params?: Record<string, never>) => Promise<PanUserInfo>;
  quota: (params?: QuotaParams) => Promise<QuotaResult>;
}

export interface UserInfo {
  profile: (options?: UserInfoOptions) => Promise<UserProfile>;
  quota: (options?: UserInfoOptions) => Promise<QuotaInfo>;
  overview: (options?: UserInfoOptions) => Promise<UserOverview>;
}

/**
 * @param source 通常传 createOpenApi() 的实例；单测里可以只传用到的那几个假端点
 */
export function createUserInfo(source: OpenApi | Partial<UserInfoDeps>): UserInfo {
  const api: UserInfoDeps =
    'defineApi' in source
      ? { userInfo: source.defineApi(USER_INFO), quota: source.defineApi(QUOTA) }
      : {
          userInfo: source.userInfo ?? missing('userInfo'),
          quota: source.quota ?? missing('quota')
        };

  async function profile(options: UserInfoOptions = {}): Promise<UserProfile> {
    return toProfile(await withRetry(() => api.userInfo(), options.retry));
  }

  /** 容量。checkfree / checkexpire 固定传 1，不然 free 和 expire 不返回。 */
  async function quota(options: UserInfoOptions = {}): Promise<QuotaInfo> {
    const raw = await withRetry(() => api.quota({ checkfree: 1, checkexpire: 1 }), options.retry);
    return toQuota(raw);
  }

  /** 两个接口没有依赖关系，并发取。任一失败整体就失败，页头本来也没法只画一半。 */
  async function overview(options: UserInfoOptions = {}): Promise<UserOverview> {
    const [me, space] = await Promise.all([profile(options), quota(options)]);
    return { profile: me, quota: space };
  }

  return { profile, quota, overview };
}
