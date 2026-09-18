'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  adminRequest,
  adminDate,
  number,
  money,
  type AdminOverview,
  type AdminTools,
  type AdminUsers,
} from '@/lib/admin-client';
import toolLabels from '../../messages/zh/tools.json';
const toolName = (id: string) => (toolLabels as Record<string, { name: string }>)[id]?.name || id;
const groups: Record<string, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  ai: 'AI',
};
export function AdminDashboard() {
  const [tab, setTab] = useState<'users' | 'tools'>('users');
  const [overview, setOverview] = useState<AdminOverview>(),
    [users, setUsers] = useState<AdminUsers>();
  const [tools, setTools] = useState<AdminTools>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [busy, setBusy] = useState(false);
  async function loadUsers(page = 1) {
    setBusy(true);
    setError('');
    try {
      setUsers(
        await adminRequest(`users?${new URLSearchParams({ query, status, page: String(page) })}`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    Promise.all([
      adminRequest<AdminOverview>('overview'),
      adminRequest<AdminUsers>('users'),
      adminRequest<{ tools: AdminTools }>('tools'),
    ])
      .then(([o, u, t]) => {
        setOverview(o);
        setUsers(u);
        setTools(t.tools);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function toggle(id: string, published: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminRequest(`tools/${id}`, { published }, 'PATCH');
      setTools((current) => current.map((t) => (t.id === id ? { ...t, published } : t)));
      setNotice(`${toolName(id)}已${published ? '上架' : '下架'}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const metrics = overview
    ? [
        ['注册用户', number(overview.users)],
        ['已封禁用户', number(overview.blockedUsers)],
        ['可用积分总额', number(overview.availableCredits)],
        ['累计手动充值积分', number(overview.grantedCredits)],
        ['累计消耗积分', number(overview.consumedCredits)],
        ['近 30 天充值金额', money(overview.recentAmountCny)],
        ['近 30 天充值笔数', number(overview.recentRecharges)],
        ['近 30 天计费操作', number(overview.recentOperations)],
      ]
    : [];
  return (
    <>
      <div className="admin-title">
        <div>
          <p className="admin-kicker">运营概览</p>
          <h1>管理控制台</h1>
          <p className="admin-muted">用户、积分与工具，在这里统一管理。</p>
        </div>
        <a href="/zh" target="_blank" rel="noreferrer">
          查看前台 ↗
        </a>
      </div>
      <div className="admin-metrics">
        {metrics.map(([label, value]) => (
          <div key={label} className="admin-panel">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <nav className="admin-tabs" aria-label="后台功能">
        <button aria-pressed={tab === 'users'} onClick={() => setTab('users')}>
          用户管理
        </button>
        <button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')}>
          工具管理 <span>{tools.length}</span>
        </button>
      </nav>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}
      {tab === 'users' ? (
        <section className="admin-panel">
          <div className="admin-section-title">
            <h2>注册用户</h2>
            <span className="admin-muted">共 {users?.total ?? '…'} 位</span>
          </div>
          <form
            className="admin-filter"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void loadUsers();
            }}
          >
            <input
              aria-label="搜索用户"
              placeholder="搜索邮箱或用户名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="用户状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">正常</option>
              <option value="blocked">已封禁</option>
            </select>
            <button className="primary" disabled={busy}>
              搜索
            </button>
          </form>
          <div className="admin-table">
            <table>
              <thead>
                <tr>
                  {[
                    '用户',
                    '状态',
                    '可用积分',
                    '预留积分',
                    '累计到账积分',
                    '累计消耗积分',
                    '注册时间',
                    '操作',
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users?.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>
                      <small>{u.email}</small>
                    </td>
                    <td>
                      <span className={`admin-badge ${u.blocked ? 'danger' : ''}`}>
                        {u.blocked ? '已封禁' : '正常'}
                      </span>
                    </td>
                    <td>{number(u.available)}</td>
                    <td>{number(u.reserved)}</td>
                    <td>{number(u.granted)}</td>
                    <td>{number(u.consumed)}</td>
                    <td>{adminDate(u.createdAt)}</td>
                    <td>
                      <Link className="admin-link" href={`/admin/users/${u.id}`}>
                        查看详情 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!users && !error && (
            <p role="status" className="admin-empty">
              正在加载…
            </p>
          )}
          {users && !users.users.length && <p className="admin-empty">没有符合条件的用户</p>}
          {users && (
            <div className="admin-pagination">
              <span>
                第 {users.page} / {Math.max(1, Math.ceil(users.total / users.pageSize))} 页
              </span>
              <button disabled={busy || users.page <= 1} onClick={() => loadUsers(users.page - 1)}>
                上一页
              </button>
              <button
                disabled={busy || users.page * users.pageSize >= users.total}
                onClick={() => loadUsers(users.page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="admin-panel">
          <div className="admin-section-title">
            <h2>工具发布状态</h2>
            <p className="admin-muted">下架后隐藏入口并停止新请求，已提交的任务继续处理。</p>
          </div>
          <div className="admin-table">
            <table>
              <thead>
                <tr>
                  {['工具', '分类', '支持格式', '状态', '操作'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{toolName(t.id)}</strong>
                      <small>{t.id}</small>
                    </td>
                    <td>{groups[t.group]}</td>
                    <td>{t.formats}</td>
                    <td>
                      <span className={`admin-badge ${t.published ? '' : 'neutral'}`}>
                        {t.published ? '已上架' : '已下架'}
                      </span>
                    </td>
                    <td>
                      <button disabled={busy} onClick={() => toggle(t.id, !t.published)}>
                        {t.published ? '下架' : '上架'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
