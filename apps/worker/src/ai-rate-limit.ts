import { createHash } from 'node:crypto';
import { sqlClient } from '@filemorph/core/db';
import { translationConfig } from '@filemorph/core/translation';

export interface ProviderProgress {
  onWait?: (until: Date | null) => Promise<void>;
  onSending?: () => Promise<void>;
}
export function retryDelay(value: string | null, attempt: number, now = Date.now()) {
  const seconds = Number(value);
  const header = value
    ? Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now
    : NaN;
  // A provider's explicit recovery time takes precedence over our fallback backoff.
  if (Number.isFinite(header)) return Math.max(1000, header);
  return 5000 * 2 ** Math.min(attempt, 4);
}
export async function abortableWait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function bucketId(model: string, scope = translationConfig().apiKey || '') {
  return createHash('sha256')
    .update(scope + ':' + model)
    .digest('hex');
}
// Smooth both request and token use across worker processes. Reservations are conservative:
// an interrupted caller leaves its slot unused instead of letting another caller burst.
export async function reserveProvider(
  model: string,
  tokens: number,
  signal: AbortSignal,
  progress: ProviderProgress,
  scope?: string,
  purpose?: 'translate' | 'reading' | 'repair',
) {
  const mt = purpose === 'translate' || model.startsWith('qwen-mt'),
    image = purpose === 'repair' || model.startsWith('qwen-image');
  const prefix = mt ? 'TRANSLATION' : image ? 'IMAGE_REPAIR' : 'AI_READING';
  const rpm = Math.max(1, Number(process.env[`${prefix}_RPM`] || (mt ? 45 : image ? 5 : 30)));
  const tpm = Math.max(1000, Number(process.env[`${prefix}_TPM`] || (mt ? 18000 : 500000)));
  const id = bucketId(model, scope);
  const due = await sqlClient().begin(async (sql) => {
    await sql`insert into ai_rate_buckets(id) values(${id}) on conflict do nothing`;
    const [row] =
      await sql`select greatest(now(),request_at,token_at) as due from ai_rate_buckets where id=${id} for update`;
    const time = new Date(row.due);
    await sql`update ai_rate_buckets set request_at=${new Date(+time + 60000 / rpm).toISOString()}::timestamptz,token_at=${new Date(+time + (Math.max(1, tokens) * 60000) / tpm).toISOString()}::timestamptz,updated_at=now() where id=${id}`;
    return time;
  });
  if (+due > Date.now() + 200) {
    await progress.onWait?.(due);
    await abortableWait(+due - Date.now(), signal);
  }
  signal.throwIfAborted();
  await progress.onWait?.(null);
}
export async function deferProvider(model: string, until: Date, scope?: string) {
  await sqlClient()`update ai_rate_buckets set request_at=greatest(request_at,${until.toISOString()}::timestamptz), token_at=greatest(token_at,${until.toISOString()}::timestamptz) where id=${bucketId(model, scope)}`;
}
