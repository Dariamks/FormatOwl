import { admitBilling } from './billing';
import { randomUUID } from 'node:crypto';
import { db, eq, and, gt } from './db';
import { assets, preparations } from './schema';
import { capacity, lockOwner, ServiceError } from './jobs';
import { supportsInput } from './domain';
import { downloadUrl } from './storage';
import type { PreparationView } from './editing';

export async function prepareAsset(
  owner: string,
  assetId: string,
  profile: 'video' | 'audio',
  streamIndex = -1,
  retry = false,
) {
  return db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [asset] = await tx
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.owner, owner),
          eq(assets.state, 'ready'),
          gt(assets.expiresAt, new Date()),
        ),
      )
      .for('update');
    if (!asset) throw new ServiceError(404, 'ASSET_NOT_FOUND');
    if (!supportsInput(profile === 'video' ? 'video-cutter' : 'audio-cutter', asset.name))
      throw new ServiceError(400, 'UNSUPPORTED_FORMAT');
    const [existing] = await tx
      .select()
      .from(preparations)
      .where(
        and(
          eq(preparations.assetId, assetId),
          eq(preparations.profile, profile),
          eq(preparations.streamIndex, streamIndex),
        ),
      );
    if (existing) {
      if (retry && ['failed', 'cancelled'].includes(existing.state)) {
        await admitBilling(tx, owner, 'prepare', existing.id, existing.attempt + 1);
        await capacity(tx, owner, 1);
        const [updated] = await tx
          .update(preparations)
          .set({
            state: 'queued',
            progress: 0,
            error: null,
            attempt: existing.attempt + 1,
            dispatchedAt: null,
            previewKey: null,
            peaksKey: null,
            thumbnailsKey: null,
          })
          .where(eq(preparations.id, existing.id))
          .returning();
        return updated;
      }
      return existing;
    }
    await capacity(tx, owner, 1);
    const [created] = await tx
      .insert(preparations)
      .values({
        id: randomUUID(),
        owner,
        assetId,
        profile,
        streamIndex,
        expiresAt: asset.expiresAt,
      })
      .returning();
    await admitBilling(tx, owner, 'prepare', created.id, 1);
    return created;
  });
}
export async function preparationView(
  owner: string,
  assetId: string,
  profile: 'video' | 'audio',
  streamIndex = -1,
): Promise<PreparationView> {
  const [row] = await db()
    .select({ prep: preparations, asset: assets })
    .from(preparations)
    .innerJoin(assets, eq(preparations.assetId, assets.id))
    .where(
      and(
        eq(preparations.owner, owner),
        eq(assets.owner, owner),
        eq(preparations.assetId, assetId),
        eq(preparations.profile, profile),
        eq(preparations.streamIndex, streamIndex),
        eq(assets.state, 'ready'),
        gt(assets.expiresAt, new Date()),
        gt(preparations.expiresAt, new Date()),
      ),
    );
  if (!row) throw new ServiceError(404, 'ASSET_NOT_FOUND');
  const { prep: p, asset: a } = row;
  const result: PreparationView = {
    id: p.id,
    assetId,
    name: a.name,
    size: a.size,
    profile,
    streamIndex: p.streamIndex,
    state: p.state,
    progress: p.progress,
    error: p.error,
    media: p.media,
    expiresAt: p.expiresAt.toISOString(),
  };
  if (p.state === 'completed') {
    if (p.previewKey)
      result.previewUrl = await downloadUrl(
        p.previewKey,
        profile === 'video' ? 'preview.mp4' : 'preview.m4a',
        true,
        profile === 'video' ? 'video/mp4' : 'audio/mp4',
      );
    if (p.peaksKey)
      result.peaksUrl = await downloadUrl(p.peaksKey, 'peaks.json', true, 'application/json');
    if (p.thumbnailsKey)
      result.thumbnailsUrl = await downloadUrl(
        p.thumbnailsKey,
        'thumbnails.jpg',
        true,
        'image/jpeg',
      );
  }
  return result;
}
