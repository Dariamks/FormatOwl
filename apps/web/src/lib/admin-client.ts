import type {
  adminOverview,
  adminUserDetail,
  listAdminTools,
  listAdminUsers,
} from '@filemorph/core/admin';
type Json<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
export type AdminOverview = Json<Awaited<ReturnType<typeof adminOverview>>>;
export type AdminUsers = Json<Awaited<ReturnType<typeof listAdminUsers>>>;
export type AdminTools = Json<Awaited<ReturnType<typeof listAdminTools>>>;
export type AdminDetail = Json<Awaited<ReturnType<typeof adminUserDetail>>>;
const errors: Record<string, string> = {
  ADMIN_REQUIRED: '登录已过期，请重新登录。',
  ADMIN_INVALID_CREDENTIALS: '账号或密码不正确。',
  ADMIN_RATE_LIMITED: '尝试次数过多，请一分钟后重试。',
  INVALID_REQUEST: '请检查填写内容：金额最多两位小数，积分必须是正整数。',
  IDEMPOTENCY_CONFLICT: '该凭证编号已有不同的充值记录，请核对后重试。',
  NOT_FOUND: '没有找到这条记录。',
  INVALID_ORIGIN: '请求来源无效，请从本站打开后台。',
};
export async function adminRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === 'ADMIN_REQUIRED') window.location.assign('/admin/login');
    throw new Error(errors[data.error] || '服务暂时不可用，请稍后重试。');
  }
  return data;
}
export const adminDate = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
export const number = (value: unknown) => Number(value || 0).toLocaleString('zh-CN');
export const money = (value: unknown) => `¥${Number(value || 0).toFixed(2)}`;
export const statusText = (value: unknown) =>
  ({
    queued: '排队中',
    processing: '处理中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    cancelling: '取消中',
    expired: '已过期',
    open: '进行中',
    settled: '已结算',
    refunded: '已退回',
    reconciling: '核对中',
    needs_quote: '需要新报价',
    grant: '充值 / 发放',
    reserve: '预留',
    settle: '消耗',
    release: '释放预留',
    refund: '退回预留',
    started: '已开始',
    unknown: '待核实',
  })[String(value)] || String(value || '—');
