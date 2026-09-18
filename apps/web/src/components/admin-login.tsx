'use client';
import { useState, type FormEvent } from 'react';
import { adminRequest } from '@/lib/admin-client';
export function AdminLogin() {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminRequest('login', { username, password });
      window.location.assign('/admin');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="admin-login">
      <form className="admin-panel" onSubmit={submit}>
        <img src="/icon.png" width="44" height="44" alt="" />
        <p className="admin-kicker">FORMATOWL · ADMIN</p>
        <h1>管理员登录</h1>
        <p className="admin-muted">管理用户、积分和工具发布状态。</p>
        <label>
          账号
          <input
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          密码
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '正在登录…' : '登录后台'}
        </button>
      </form>
    </main>
  );
}
