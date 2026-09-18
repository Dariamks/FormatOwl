'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  adminRequest,
  adminDate,
  number,
  money,
  statusText,
  type AdminDetail,
} from '@/lib/admin-client';
import toolLabels from '../../messages/zh/tools.json';
const toolName = (id: unknown) =>
  (toolLabels as Record<string, { name: string }>)[String(id)]?.name || String(id || '—');
function Records({
  title,
  headers,
  children,
  empty,
  page,
  pageSize,
  total,
  loading,
  onPage,
}: {
  title: string;
  headers: string[];
  children: ReactNode;
  empty: boolean;
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <section className="admin-panel">
      <div className="admin-section-title">
        <h2>{title}</h2>
        <span className="admin-muted">共 {total} 条 · 北京时间</span>
      </div>
      {loading ? (
        <p role="status" className="admin-empty">
          正在加载记录…
        </p>
      ) : empty ? (
        <p className="admin-empty">暂无记录</p>
      ) : (
        <div className="admin-table">
          <table>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
      <div className="admin-pagination">
        <span>
          第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
        </span>
        <button disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <button disabled={loading || page * pageSize >= total} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </section>
  );
}
export function AdminUserDetail({ userId }: { userId: string }) {
  const [data, setData] = useState<AdminDetail>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [reason, setReason] = useState('');
  const [amount, setAmount] = useState(''),
    [credits, setCredits] = useState(''),
    [receipt, setReceipt] = useState(''),
    [note, setNote] = useState('');
  const [tab, setTab] = useState('tasks');
  const [historyPage, setHistoryPage] = useState(1),
    [loading, setLoading] = useState(false);
  const path = `users/${encodeURIComponent(userId)}`;
  const detailPath = `${path}?historyPage=${historyPage}`;
  async function refresh() {
    setData(await adminRequest<AdminDetail>(detailPath));
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    adminRequest<AdminDetail>(detailPath)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [detailPath]);
  function recordProps(key: keyof AdminDetail['history']['total']) {
    return {
      page: historyPage,
      pageSize: data!.history.pageSize,
      total: data!.history.total[key],
      loading,
      onPage: setHistoryPage,
    };
  }
  async function recharge(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminRequest(`${path}/recharge`, {
        receipt,
        amountCny: Number(amount),
        credits: Number(credits),
        note,
      });
      await refresh();
      setNotice('充值已入账，余额和积分流水已更新。');
      setAmount('');
      setCredits('');
      setReceipt('');
      setNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus() {
    if (!data) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminRequest(`${path}/status`, { blocked: !data.user.blocked, reason }, 'PATCH');
      await refresh();
      setNotice(data.user.blocked ? '用户已恢复使用。' : '用户已封禁，新处理请求已停止。');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="admin-link" href="/admin">
        ← 返回管理控制台
      </Link>
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
      {!data ? (
        <p className="admin-empty">{error ? '无法加载用户详情' : '正在加载用户详情…'}</p>
      ) : (
        <>
          <div className="admin-title">
            <div>
              <p className="admin-kicker">用户详情</p>
              <h1>{data.user.name}</h1>
              <p>{data.user.email}</p>
              <small className="admin-muted">
                注册于 {adminDate(data.user.createdAt)} · {data.user.id}
              </small>
            </div>
            <span className={`admin-badge ${data.user.blocked ? 'danger' : ''}`}>
              {data.user.blocked ? '已封禁' : '正常'}
            </span>
          </div>
          <div className="admin-metrics">
            {[
              ['可用积分', number(data.user.available)],
              ['预留积分', number(data.user.reserved)],
              ['累计充值金额', money(data.totals.amountCny)],
              ['累计到账积分', number(data.totals.granted)],
              ['累计消耗积分', number(data.totals.consumed)],
            ].map(([k, v]) => (
              <div key={k} className="admin-panel">
                <span>{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
          </div>
          <div className="admin-detail-actions">
            <section className="admin-panel">
              <h2>手动充值</h2>
              <p className="admin-muted">
                录入已核对的收款金额和到账积分，凭证编号用于防止重复入账。
              </p>
              <form className="admin-form-grid" onSubmit={recharge}>
                <label>
                  充值金额（元）
                  <input
                    type="number"
                    min="0"
                    max="9999999999.99"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </label>
                <label>
                  到账积分
                  <input
                    type="number"
                    min="1"
                    max="1000000000"
                    step="1"
                    value={credits}
                    onChange={(e) => setCredits(e.target.value)}
                    required
                  />
                </label>
                <label>
                  凭证编号
                  <input
                    maxLength={200}
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    required
                  />
                </label>
                <label>
                  充值备注
                  <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? '处理中…' : '确认充值'}
                </button>
              </form>
            </section>
            <section className="admin-panel">
              <h2>账号状态</h2>
              <p className="admin-muted">
                封禁后无法上传或执行新任务，历史记录可查看、下载和取消。
              </p>
              {data.user.blocked && (
                <p>
                  封禁时间：{adminDate(data.user.blockedAt)}
                  <br />
                  原因：{data.user.blockedReason || '未填写'}
                </p>
              )}
              <label>
                封禁原因（选填）
                <input
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={data.user.blocked}
                />
              </label>
              <button
                className={data.user.blocked ? '' : 'danger-button'}
                disabled={busy}
                onClick={changeStatus}
              >
                {data.user.blocked ? '恢复使用' : '封禁用户'}
              </button>
            </section>
          </div>
          <nav className="admin-tabs" aria-label="用户记录">
            {[
              ['tasks', '工具使用'],
              ['recharges', '充值记录'],
              ['ledger', '积分流水'],
              ['operations', '计费操作'],
              ['usage', '用量明细'],
            ].map(([key, title]) => (
              <button
                key={key}
                aria-pressed={tab === key}
                onClick={() => {
                  setTab(key);
                  setHistoryPage(1);
                }}
              >
                {title}
              </button>
            ))}
          </nav>
          {tab === 'tasks' && (
            <Records
              title="工具使用记录"
              {...recordProps('tasks')}
              headers={['文件 / 任务', '工具', '状态', '尝试次数', '创建时间', '文件到期时间']}
              empty={!data.tasks.length}
            >
              {data.tasks.map((t) => (
                <tr key={String(t.id)}>
                  <td>
                    <strong>{String(t.name)}</strong>
                    <small>{String(t.id)}</small>
                    {Boolean(t.error) && <small>{String(t.error)}</small>}
                  </td>
                  <td>{toolName(t.tool)}</td>
                  <td>{statusText(t.state)}</td>
                  <td>{number(t.attempt)}</td>
                  <td>{adminDate(t.created_at)}</td>
                  <td>{adminDate(t.expires_at)}</td>
                </tr>
              ))}
            </Records>
          )}
          {tab === 'recharges' && (
            <Records
              title="充值记录"
              {...recordProps('recharges')}
              headers={['时间', '充值金额', '到账积分', '凭证编号', '备注', '管理员']}
              empty={!data.recharges.length}
            >
              {data.recharges.map((r) => (
                <tr key={r.id}>
                  <td>{adminDate(r.createdAt)}</td>
                  <td>{money(r.amountCny)}</td>
                  <td>+{number(r.credits)}</td>
                  <td>{r.receipt}</td>
                  <td>{r.note || '—'}</td>
                  <td>{r.adminUsername}</td>
                </tr>
              ))}
            </Records>
          )}
          {tab === 'ledger' && (
            <Records
              title="积分流水"
              {...recordProps('ledger')}
              headers={['时间', '类型', '可用变动', '预留变动', '说明']}
              empty={!data.ledger.length}
            >
              {data.ledger.map((r) => (
                <tr key={r.id}>
                  <td>{adminDate(r.createdAt)}</td>
                  <td>{statusText(r.kind)}</td>
                  <td>
                    {r.availableDelta > 0 ? '+' : ''}
                    {number(r.availableDelta)}
                  </td>
                  <td>
                    {r.reservedDelta > 0 ? '+' : ''}
                    {number(r.reservedDelta)}
                  </td>
                  <td>{r.note}</td>
                </tr>
              ))}
            </Records>
          )}
          {tab === 'operations' && (
            <Records
              title="计费操作"
              {...recordProps('operations')}
              headers={['时间 / 编号', '工具 / 操作', '状态', '预留积分', '实际消耗积分']}
              empty={!data.operations.length}
            >
              {data.operations.map((r) => (
                <tr key={r.id}>
                  <td>
                    {adminDate(r.createdAt)}
                    <small>{r.id}</small>
                  </td>
                  <td>{String(r.tools).split(', ').map(toolName).join('、')}</td>
                  <td>{statusText(r.state)}</td>
                  <td>{number(r.reservedCredits)}</td>
                  <td>{number(r.chargedCredits)}</td>
                </tr>
              ))}
            </Records>
          )}
          {tab === 'usage' && (
            <Records
              title="用量明细"
              {...recordProps('usage')}
              headers={['时间 / 计费操作', '工具', '阶段 / 计量', '数量', '处理成本（元）', '状态']}
              empty={!data.usage.length}
            >
              {data.usage.map((r) => (
                <tr key={r.id}>
                  <td>
                    {adminDate(r.createdAt)}
                    <small>{String(r.operationId)}</small>
                  </td>
                  <td>{toolName(r.tool)}</td>
                  <td>
                    {String(r.stage)}
                    <small>{String(r.meter)}</small>
                  </td>
                  <td>{number(r.quantity)}</td>
                  <td>
                    {r.costMicroCny === null ? '待核实' : `¥${(r.costMicroCny / 1e6).toFixed(6)}`}
                  </td>
                  <td>{statusText(r.state)}</td>
                </tr>
              ))}
            </Records>
          )}
        </>
      )}
    </>
  );
}
