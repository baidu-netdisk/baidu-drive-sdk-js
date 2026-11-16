import { useCallback, useEffect, useState } from 'react';
import type { BrowseFile } from 'baidu-drive-sdk-js/scene/file-browse';
import { ApiError, needsReauth } from 'baidu-drive-sdk-js/api';
import { formatBytes } from 'baidu-drive-sdk-js/scene/user-info';
import type { UserProfile } from 'baidu-drive-sdk-js/scene/user-info';
import {
  describePanError,
  getAuth,
  getBrowse,
  getUserInfoService,
  isPanConfigured
} from './pan';
import { formatTime, segmentsOf } from './format';

const ROOT = '/';

type Status = 'boot' | 'anon' | 'authorizing' | 'ready';

export default function App() {
  const [status, setStatus] = useState<Status>('boot');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [dir, setDir] = useState(ROOT);
  const [files, setFiles] = useState<BrowseFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = useCallback(async (target: string) => {
    setLoading(true);
    setError('');
    try {
      const list = await getBrowse().listDir(target);
      setFiles(list);
      setDir(target);
    } catch (e) {
      setError(describePanError(e));
      // token 失效类的错误重试无意义，直接清登录态
      if (e instanceof ApiError && needsReauth(e.errno)) {
        getAuth().logout();
        setUser(null);
        setStatus('anon');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const profile = await getUserInfoService().profile();
    setUser(profile);
    setStatus('ready');
  }, []);

  // 启动：有缓存凭据就校验并拉根目录；没有就停在未登录
  useEffect(() => {
    if (!isPanConfigured()) {
      setError('未配置 VITE_PAN_APP_KEY，无法登录网盘；请复制 .env.example 为 .env.local 并填入 AppKey');
      setStatus('anon');
      return;
    }
    if (!getAuth().load()) {
      setStatus('anon');
      return;
    }
    refreshProfile()
      .then(() => loadDir(ROOT))
      .catch((e) => {
        if (e instanceof ApiError && needsReauth(e.errno)) {
          getAuth().logout();
          setUser(null);
          setStatus('anon');
        } else {
          setError(describePanError(e));
          setStatus('anon');
        }
      });
  }, [refreshProfile, loadDir]);

  const login = async () => {
    setStatus('authorizing');
    setError('');
    try {
      await getAuth().authorize();
      await refreshProfile();
      await loadDir(ROOT);
    } catch (e) {
      setError(describePanError(e));
      setStatus('anon');
    }
  };

  const logout = () => {
    getAuth().logout();
    setUser(null);
    setFiles([]);
    setDir(ROOT);
    setError('');
    setStatus('anon');
  };

  const parentOf = (path: string): string | null => {
    if (path === ROOT) return null;
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? ROOT : path.slice(0, idx);
  };
  const parent = parentOf(dir);

  const segs = segmentsOf(dir);
  const goTo = (path: string) => void loadDir(path);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">☁️</span>
          <span>网盘文件浏览器</span>
        </div>
        <div className="profile">
          {status === 'authorizing' && <span className="hint">授权中…</span>}
          {user !== null && (
            <>
              {user.avatarUrl ? (
                <img className="avatar" src={user.avatarUrl} alt="头像" />
              ) : (
                <span className="avatar fallback">👤</span>
              )}
              <span className="name">{user.displayName}</span>
              <span className="vip">{user.vipLabel}</span>
              <button className="ghost" onClick={logout}>退出登录</button>
            </>
          )}
          {user === null && status !== 'authorizing' && (
            <button className="primary" onClick={login} disabled={!isPanConfigured()}>
              {isPanConfigured() ? '登录百度网盘' : '未配置 AppKey'}
            </button>
          )}
        </div>
      </header>

      {error !== '' && <div className="banner error">{error}</div>}
      {status === 'anon' && user === null && error === '' && (
        <div className="empty">
          <p>登录后即可查询网盘文件列表。</p>
          <button className="primary" onClick={login} disabled={!isPanConfigured()}>
            {isPanConfigured() ? '登录百度网盘' : '未配置 AppKey'}
          </button>
        </div>
      )}

      {user !== null && (
        <main className="files">
          <div className="crumb">
            <button className="link" onClick={() => goTo(ROOT)}>全部文件</button>
            {segs.map((seg, i) => {
              const path = '/' + segs.slice(0, i + 1).join('/');
              return (
                <span key={path}>
                  <span className="sep">/</span>
                  <button className="link" onClick={() => goTo(path)}>{seg}</button>
                </span>
              );
            })}
            <span className="spacer" />
            {parent !== null && (
              <button className="ghost" onClick={() => goTo(parent)}>⬆ 上一级</button>
            )}
            <button className="ghost" onClick={() => void loadDir(dir)} disabled={loading}>
              刷新
            </button>
          </div>

          {loading && <div className="banner">正在读取网盘目录…</div>}

          {!loading && files.length === 0 && error === '' && (
            <div className="empty small">该目录没有文件。</div>
          )}

          {!loading && files.length > 0 && (
            <table className="list">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>大小</th>
                  <th>修改时间</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.fs_id} className={f.isdir === 1 ? 'dir' : ''}>
                    <td>
                      {f.isdir === 1 ? (
                        <button className="link dirname" onClick={() => goTo(f.decodedPath)}>
                          📁 {f.name}
                        </button>
                      ) : (
                        <span className="filename">📄 {f.name}</span>
                      )}
                    </td>
                    <td>{f.isdir === 1 ? '—' : formatBytes(f.size)}</td>
                    <td>{formatTime(f.server_mtime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </main>
      )}
    </div>
  );
}
