import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, eq, and, inArray, sql } from '@filemorph/core/db';
import {
  billingProbes,
  billingTargets,
  assets,
  jobs,
  preparations,
  archives,
  transcriptExports,
  translationExports,
  translationActivities,
  watermarkRuns,
  costUsage,
  billingOperations,
} from '@filemorph/core/schema';
import { downloadToFile } from '@filemorph/core/storage';
import { runProcess } from '@filemorph/core/media';
import { withUsage, recordPlatformUsage } from '@filemorph/core/billing-usage';
import { finishBillingTarget, billingTargetKey, billingAlert } from '@filemorph/core/billing';
import { fileCategory } from '@filemorph/core/domain';
import type { BillingFacts } from '@filemorph/core/billing-model';
import { probeEditor } from './processors/editor';
import { pythonBinary } from './processors';
const targets = {
  job: jobs,
  prepare: preparations,
  archive: archives,
  'transcript-export': transcriptExports,
  'translation-export': translationExports,
  reading: translationActivities,
  'watermark-run': watermarkRuns,
};
export async function finishTarget(kind: string, id: string, attempt: number) {
  const table = targets[kind as keyof typeof targets];
  if (!table) return;
  const [row] = await db().select().from(table).where(eq(table.id, id));
  if (!row) {
    await finishBillingTarget(billingTargetKey(kind, id, attempt), 'cancelled');
    return;
  }
  if ('attempt' in row && row.attempt !== attempt) return;
  if (!['completed', 'cancelled', 'failed', 'expired'].includes(row.state)) return;
  const error = 'error' in row ? row.error : null;
  const paused =
    error &&
    [
      'BILLING_BUDGET_EXCEEDED',
      'BILLING_STAGE_REQUIRED',
      'BILLING_PAUSED',
      'PRICE_UNVERIFIED',
    ].includes(error);
  await finishBillingTarget(
    billingTargetKey(kind, id, attempt),
    paused ? 'paused' : row.state === 'expired' ? 'cancelled' : row.state,
    error,
  );
}
export async function runBilled<T>(
  kind: string,
  id: string,
  attempt: number,
  run: () => Promise<T>,
) {
  try {
    return await withUsage(kind, id, attempt, run);
  } finally {
    await finishTarget(kind, id, attempt);
  }
}
export async function reconcileBillingTargets() {
  const rows = await db()
    .select()
    .from(billingTargets)
    .where(eq(billingTargets.state, 'pending'))
    .limit(100);
  for (const row of rows) await finishTarget(row.kind, row.targetId, row.attempt);
  const uncertain = await db()
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.state, 'reconciling'))
    .limit(20);
  for (const row of uncertain)
    await billingAlert('RECONCILIATION_REQUIRED', row.id, {
      reason: 'Uncertain or missing provider usage; reservation retained',
    });
}
export async function processBillingProbe(
  id: string,
  tempRoot: string,
  controllers: Set<AbortController>,
  activeTemp: Set<string>,
) {
  const [p] = await db()
    .update(billingProbes)
    .set({ state: 'processing', updatedAt: new Date() })
    .where(
      and(eq(billingProbes.assetId, id), inArray(billingProbes.state, ['queued', 'processing'])),
    )
    .returning();
  if (!p) return;
  const started = Date.now();
  let transferredBytes = 0;
  let probedFacts: BillingFacts | undefined;
  const controller = new AbortController();
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 60000);
  let temp: string | undefined;
  try {
    const [a] = await db()
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, id),
          eq(assets.owner, p.owner),
          eq(assets.state, 'ready'),
          sql`${assets.expiresAt}>now()`,
        ),
      );
    if (!a) throw new Error('EXPIRED');
    temp = await mkdtemp(join(tempRoot, 'billing-probe-'));
    activeTemp.add(temp);
    const input = join(temp, 'input');
    await downloadToFile(a.key, input, controller.signal);
    transferredBytes = a.size;
    let facts: BillingFacts;
    if (['video', 'audio'].includes(fileCategory(a.name) || '')) {
      const m = await probeEditor(input, controller.signal);
      const raw = await runProcess(
        process.env.FFPROBE_PATH || 'ffprobe',
        ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-of', 'json', input],
        controller.signal,
        undefined,
        15000,
      );
      const stream = JSON.parse(raw).streams?.find((s: any) => s.codec_type === 'video'),
        [num, den] = String(stream?.avg_frame_rate || '0/1')
          .split('/')
          .map(Number);
      facts = {
        bytes: a.size,
        duration: m.duration,
        width: m.width,
        height: m.height,
        fps: den ? num / den : 0,
        channels: m.tracks.find((t) => t.index === m.defaultAudioIndex)?.channels || 1,
        source: 'worker-ffprobe',
      };
    } else {
      facts = JSON.parse(
        await runProcess(
          pythonBinary,
          [fileURLToPath(new URL('../python/billing_probe.py', import.meta.url)), input, a.name],
          controller.signal,
          undefined,
          45000,
        ),
      );
    }
    probedFacts = facts;
  } catch {
    await db()
      .update(billingProbes)
      .set({ state: 'failed', error: 'PROBE_FAILED', updatedAt: new Date() })
      .where(eq(billingProbes.assetId, id));
  } finally {
    try {
      await db().transaction(async (tx) => {
        const key = `probe:${id}:${p.updatedAt.getTime()}`;
        await recordPlatformUsage(
          key + ':runtime',
          'runtime_ms',
          Date.now() - started,
          { assetId: id, measurement: 'probe_occupied_slot_ms' },
          tx,
        );
        await recordPlatformUsage(key + ':read', 'storage_read', 1, { assetId: id }, tx);
        if (transferredBytes)
          await recordPlatformUsage(
            key + ':transfer',
            'transfer_gib',
            transferredBytes / 1024 ** 3,
            { assetId: id },
            tx,
          );
        if (probedFacts)
          await tx
            .update(billingProbes)
            .set({ state: 'completed', facts: probedFacts, error: null, updatedAt: new Date() })
            .where(eq(billingProbes.assetId, id));
      });
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      if (temp) {
        await rm(temp, { recursive: true, force: true });
        activeTemp.delete(temp);
      }
    }
  }
}
