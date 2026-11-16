// 凭据缓存：过期判定、scope 子集判定、按 app 隔离的存储 key。
// 存储是可注入的（CredentialStore），所以可以换成内存、sessionStorage 或 zustand。

const STORE_PREFIX = 'pan-oauth-v1-';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const MANUAL_TOKEN_TTL_MS = 2592000 * 1000;
const SCOPE_SEP = /[,\s]+/;

export interface Credential {
  accessToken: string;
  /** 简化模式不返回 refresh_token，这里恒为空串，保留字段是为了将来接授权码模式 */
  refreshToken: string;
  expiresAt: number;
  requestedScope: string;
}

export interface CredentialStore {
  load: (key: string) => Credential | null;
  save: (key: string, credential: Credential) => void;
  remove: (key: string) => void;
}

interface StoredEnvelope {
  version: 1;
  credential: Credential;
}

export function createMemoryCredentialStore(): CredentialStore {
  const data = new Map<string, Credential>();
  return {
    load: (key) => data.get(key) ?? null,
    save: (key, credential) => void data.set(key, credential),
    remove: (key) => void data.delete(key)
  };
}

// 没有 localStorage 的环境（Node、测试）自动退化成内存存储
export function createLocalCredentialStore(): CredentialStore {
  if (typeof localStorage === 'undefined') return createMemoryCredentialStore();
  return {
    load(key) {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const envelope = JSON.parse(raw) as StoredEnvelope;
        if (envelope?.version !== 1 || !envelope.credential?.accessToken) return null;
        return envelope.credential;
      } catch {
        return null;
      }
    },
    save(key, credential) {
      const envelope: StoredEnvelope = { version: 1, credential };
      localStorage.setItem(key, JSON.stringify(envelope));
    },
    remove(key) {
      localStorage.removeItem(key);
    }
  };
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// 把 appKey + 回调地址 + scope 哈希进 key，所以同一个 origin 下的多个 app 不会互相串台。
// 只用于命名空间隔离，不是安全措施。
export function credentialStoreKey(appKey: string, redirectUri: string, scope: string): string {
  return STORE_PREFIX + fnv1a([appKey, redirectUri, scope].join(' '));
}

function splitScope(scope: string): string[] {
  return scope
    .split(SCOPE_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 留 5 分钟提前量：别在请求发出的瞬间刚好过期。
// scope 要求已授权集合覆盖需求集合，否则即便 token 没过期也得重新授权。
export function credentialUsable(
  credential: Credential | null,
  requiredScope: string,
  now: number = Date.now()
): boolean {
  if (!credential || !credential.accessToken.trim()) return false;
  if (!credential.expiresAt || credential.expiresAt <= now + EXPIRY_SKEW_MS) return false;
  const granted = splitScope(credential.requestedScope);
  return splitScope(requiredScope).every((item) => granted.includes(item));
}

export function manualCredential(accessToken: string, scope: string): Credential {
  return {
    accessToken: accessToken.trim(),
    refreshToken: '',
    expiresAt: Date.now() + MANUAL_TOKEN_TTL_MS,
    requestedScope: scope
  };
}
