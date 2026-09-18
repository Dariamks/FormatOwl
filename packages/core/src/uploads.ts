import { assertOwnerNotBlocked } from './access';
import { recordPlatformUsage } from './billing-usage';
import { randomUUID } from 'node:crypto';
import { db, eq, and, gt, gte, sql } from './db';
import { assets } from './schema';
import { limits } from './config';
import { ServiceError, lockOwner } from './jobs';
import { fileTool, maxFileSize, mimeForName } from './domain';
import { beginUpload, listParts, signPart, finishUpload, headObject } from './storage';
export async function createUpload(owner: string, name: string, size: number) {
  await assertOwnerNotBlocked(owner);
  const tool = fileTool(name);
  if (!tool) throw new ServiceError(400, 'UNSUPPORTED_FORMAT');
  if (size <= 0 || size > Math.min(limits.maxUploadBytes, maxFileSize(tool)))
    throw new ServiceError(413, 'FILE_TOO_LARGE');
  const id = randomUUID(),
    key = `inputs/${id}/source`;
  await db().transaction(async (tx) => {
    await lockOwner(tx, owner);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(assets)
      .where(and(eq(assets.owner, owner), gte(assets.createdAt, new Date(Date.now() - 86400_000))));
    if (count >= limits.maxDailyUploads) throw new ServiceError(429, 'UPLOAD_LIMIT');
    await tx.insert(assets).values({
      id,
      owner,
      key,
      name,
      size,
      mime: mimeForName(name),
      expiresAt: new Date(Date.now() + limits.ttlMs),
    });
  });
  try {
    const uploadId = await beginUpload(key);
    await db().update(assets).set({ uploadId }).where(eq(assets.id, id));
  } catch (error) {
    await db().update(assets).set({ state: 'deleting' }).where(eq(assets.id, id));
    throw error;
  }
  return { id, partSize: limits.partSize, state: 'uploading', parts: [] };
}
export async function assetForOwner(id: string, owner: string) {
  const [asset] = await db()
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.owner, owner), gt(assets.expiresAt, new Date())));
  if (!asset || ['expired', 'deleting'].includes(asset.state))
    throw new ServiceError(404, 'ASSET_NOT_FOUND');
  return asset;
}
export async function uploadStatus(id: string, owner: string) {
  const asset = await assetForOwner(id, owner);
  let parts: { PartNumber: number; ETag: string; Size: number }[] = [];
  if (asset.state === 'uploading' && asset.uploadId) {
    try {
      parts = (await listParts(asset.key, asset.uploadId)).map((p) => ({
        PartNumber: p.PartNumber!,
        ETag: p.ETag!,
        Size: p.Size!,
      }));
    } catch (error) {
      if ((error as { name: string }).name !== 'NoSuchUpload') throw error;
    }
  }
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    state: asset.state,
    partSize: limits.partSize,
    parts,
  };
}
export async function uploadPart(id: string, owner: string, number: number) {
  const asset = await assetForOwner(id, owner);
  if (asset.state !== 'uploading' || !asset.uploadId)
    throw new ServiceError(409, 'UPLOAD_NOT_ACTIVE');
  if (number < 1 || number > Math.ceil(asset.size / limits.partSize))
    throw new ServiceError(400, 'INVALID_PART');
  const size = Math.min(limits.partSize, asset.size - (number - 1) * limits.partSize);
  return { url: await signPart(asset.key, asset.uploadId, number, size) };
}
export async function completeUpload(id: string, owner: string) {
  return db().transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.owner, owner), gt(assets.expiresAt, new Date())))
      .for('update');
    if (!asset || ['deleting', 'expired'].includes(asset.state))
      throw new ServiceError(404, 'ASSET_NOT_FOUND');
    if (asset.state === 'ready') return { id: asset.id };
    if (!asset.uploadId) throw new ServiceError(409, 'UPLOAD_NOT_ACTIVE');
    try {
      const parts = await listParts(asset.key, asset.uploadId);
      const count = Math.ceil(asset.size / limits.partSize);
      if (
        parts.length !== count ||
        parts.some(
          (p, i) =>
            p.PartNumber !== i + 1 ||
            p.Size !== Math.min(limits.partSize, asset.size - i * limits.partSize) ||
            !p.ETag,
        )
      )
        throw new ServiceError(400, 'INCOMPLETE_UPLOAD');
      await finishUpload(
        asset.key,
        asset.uploadId,
        parts.map((p) => ({ PartNumber: p.PartNumber!, ETag: p.ETag! })),
      );
    } catch (error) {
      if ((error as { name: string }).name !== 'NoSuchUpload') throw error;
    }
    // Recovers a successful CompleteMultipartUpload whose database commit was interrupted.
    const object = await headObject(asset.key);
    if (object.ContentLength !== asset.size) throw new ServiceError(400, 'SIZE_MISMATCH');
    await recordPlatformUsage(
      `upload:${id}:write`,
      'storage_write',
      Math.ceil(asset.size / limits.partSize) + 2,
      { assetId: id, measurement: 'validated_multipart_request_allocation' },
      tx,
    );
    await recordPlatformUsage(
      `upload:${id}:transfer`,
      'transfer_gib',
      asset.size / 1024 ** 3,
      { assetId: id, measurement: 'validated_upload_bytes' },
      tx,
    );
    await recordPlatformUsage(
      `upload:${id}:retention`,
      'storage_gib_day',
      (asset.size / 1024 ** 3) * (Math.max(0, asset.expiresAt.getTime() - Date.now()) / 86400000),
      { assetId: id, measurement: 'remaining_retention_allocation' },
      tx,
    );
    await tx.update(assets).set({ state: 'ready', uploadId: null }).where(eq(assets.id, id));
    return { id };
  });
}
