'use client';
import Link from 'next/link';
import { useState } from 'react';
import { adminRequest } from '@/lib/admin-client';
export function AdminHeader({ username }: { username: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <header className="admin-header">
      <Link className="admin-brand" href="/admin">
        <img src="/icon.png" width="32" height="32" alt="" />
        FormatOwl <span>管理后台</span>
      </Link>
      <div>
        <span>{username}</span>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await adminRequest('logout', {});
              window.location.assign('/admin/login');
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          退出登录
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </header>
  );
}
