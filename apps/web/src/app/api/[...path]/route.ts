import { createQuote, readQuote } from '@filemorph/core/billing-quotes';
import { billingOverview, billingReceipt, billingConfig, account } from '@filemorph/core/billing';
import {
  readWatermark,
  saveWatermark,
  createWatermarkRun,
  changeWatermarkRun,
  watermarkMedia,
  watermarkDownload,
  watermarkCapabilities,
} from '@filemorph/core/watermarks';
import {
  translationCapabilities,
  readTranslation,
  patchTranslation,
  retryTranslationBlocks,
  translationMedia,
  listTranslationExports,
  createTranslationExport,
  translationDownload,
  translationExportForOwner,
  changeTranslationExport,
} from '@filemorph/core/translations';
import {
  listReading,
  createReading,
  readingDownload,
  changeReading,
} from '@filemorph/core/reading-jobs';
import { transcriptEnabled, transcriptionConfig } from '@filemorph/core/transcription';
import {
  readTranscript,
  patchTranscript,
  listTranscriptExports,
  createTranscriptExport,
  transcriptDownload,
  transcriptExportForOwner,
  changeTranscriptExport,
} from '@filemorph/core/transcripts';
import { prepareAsset, preparationView } from '@filemorph/core/preparations';
import { z } from 'zod';
import { api, jsonBody } from '@/lib/api';
import {
  createUpload,
  uploadStatus,
  uploadPart,
  completeUpload,
  assetForOwner,
} from '@filemorph/core/uploads';
import {
  createJob,
  listJobs,
  jobForOwner,
  jobView,
  changeJob,
  ServiceError,
  createBatch,
  batchForOwner,
  changeBatch,
  createArchive,
  archiveForOwner,
} from '@filemorph/core/jobs';
import {
  compressionSchema,
  outputFilename,
  toolSchema,
  jobSpecSchema,
  supportsInput,
  batchToolSchema,
  mimeForName,
} from '@filemorph/core/domain';
import { downloadUrl } from '@filemorph/core/storage';
import { db, eq, and, gt, sql } from '@filemorph/core/db';
import { assets } from '@filemorph/core/schema';
import { assertToolPublished } from '@filemorph/core/access';
import { createWaffoCheckout, waffoOverview } from '@/lib/waffo';
export const runtime = 'nodejs';
const idSchema = z.string().uuid();
const pageSchema = z.coerce.number().int().min(1).max(2147483647);
const requestPage = (request: Request) =>
  pageSchema.parse(new URL(request.url).searchParams.get('page') ?? 1);
export const GET = api(async (request, path, owner) => {
  if (path.join('/') === 'billing') {
    const overview = await billingOverview(owner, requestPage(request));
    return { ...overview, payments: waffoOverview(overview.salesEnabled) };
  }
  if (path[0] === 'billing' && path[1] === 'receipts' && path.length === 3)
    return billingReceipt(owner, idSchema.parse(path[2]));
  if (path[0] === 'quotes' && path.length === 2) return readQuote(owner, idSchema.parse(path[1]));
  if (path[0] === 'jobs' && path[2] === 'watermark') {
    const id = idSchema.parse(path[1]);
    if (path.length === 3) return readWatermark(id, owner);
    if (path.length === 4 && path[3] === 'media')
      return watermarkMedia(id, owner, new URL(request.url).searchParams);
  }
  if (path[0] === 'watermark-runs' && path.length === 3 && path[2] === 'download')
    return watermarkDownload(idSchema.parse(path[1]), owner);

  if (path[0] === 'jobs' && path[2] === 'reading' && path.length === 3)
    return listReading(idSchema.parse(path[1]), owner);
  if (path[0] === 'reading-activities' && path[2] === 'download' && path.length === 3)
    return readingDownload(
      idSchema.parse(path[1]),
      owner,
      z
        .enum(['preview', 'md', 'png', 'svg'])
        .parse(new URL(request.url).searchParams.get('format') || 'md'),
    );
  if (path.join('/') === 'capabilities') {
    let provider: string | null = null;
    let providerKind: string | null = null;
    try {
      provider = transcriptionConfig().provider;
      providerKind = transcriptionConfig().kind;
    } catch {}
    return {
      ...(await translationCapabilities()),
      watermark: watermarkCapabilities(),
      transcription: transcriptEnabled(),
      transcriptionProvider: provider,
      transcriptionProviderKind: providerKind,
    };
  }
  if (path[0] === 'jobs' && path[2] === 'translation') {
    const id = idSchema.parse(path[1]);
    if (path.length === 3) return readTranslation(id, owner);
    if (path.length === 4 && path[3] === 'exports')
      return { exports: await listTranslationExports(id, owner) };
    if (path.length === 4 && path[3] === 'media') {
      const query = new URL(request.url).searchParams;
      return translationMedia(
        id,
        owner,
        z.coerce
          .number()
          .int()
          .min(0)
          .max(99)
          .parse(query.get('page') || 0),
        z.enum(['original', 'background', 'preview']).parse(query.get('kind') || 'original'),
      );
    }
  }
  if (path[0] === 'translation-exports') {
    const id = idSchema.parse(path[1]);
    if (path.length === 3 && path[2] === 'download')
      return translationDownload(
        id,
        owner,
        new URL(request.url).searchParams.get('inline') === '1',
      );
    if (path.length === 2) {
      const e = await translationExportForOwner(id, owner);
      return { id: e.id, state: e.state, error: e.error, options: e.options };
    }
  }
  if (path[0] === 'jobs' && path[2] === 'transcript') {
    if (path.length === 3)
      return readTranscript(
        idSchema.parse(path[1]),
        owner,
        z.coerce
          .number()
          .int()
          .min(0)
          .max(20000)
          .parse(new URL(request.url).searchParams.get('offset') ?? 0),
      );
    if (path.length === 4 && path[3] === 'exports')
      return { exports: await listTranscriptExports(idSchema.parse(path[1]), owner) };
  }
  if (path[0] === 'transcript-exports') {
    const id = idSchema.parse(path[1]);
    if (path.length === 3 && path[2] === 'download') return transcriptDownload(id, owner);
    if (path.length === 2) {
      const e = await transcriptExportForOwner(id, owner);
      return { id: e.id, state: e.state, error: e.error };
    }
  }

  if (path[0] === 'assets' && path.length === 3 && path[2] === 'prepare') {
    const query = new URL(request.url).searchParams;
    return preparationView(
      owner,
      idSchema.parse(path[1]),
      z.enum(['video', 'audio']).parse(query.get('profile')),
      z.coerce
        .number()
        .int()
        .min(-1)
        .max(255)
        .parse(query.get('streamIndex') ?? -1),
    );
  }
  if (path.join('/') === 'session') return { signedIn: owner.startsWith('user:') };
  if (path[0] === 'batches' && path.length === 2)
    return { batch: await batchForOwner(idSchema.parse(path[1]), owner) };
  if (path[0] === 'archives' && path.length === 2) {
    const archive = await archiveForOwner(idSchema.parse(path[1]), owner);
    return {
      id: archive.id,
      state: archive.state,
      count: archive.members.length,
      error: archive.error,
      ...(archive.state === 'completed'
        ? { url: await downloadUrl(archive.key, 'formatowl-results.zip', false, 'application/zip') }
        : {}),
    };
  }
  if (path.join('/') === 'jobs') return listJobs(owner, requestPage(request));
  if (path[0] === 'uploads' && path.length === 2)
    return uploadStatus(idSchema.parse(path[1]), owner);
  if (path[0] === 'jobs' && (path.length === 2 || (path.length === 3 && path[2] === 'download'))) {
    const row = await jobForOwner(idSchema.parse(path[1]), owner);
    if (path.length === 2) return { job: jobView(row) };
    if (row.job.expiresAt <= new Date()) throw new ServiceError(410, 'EXPIRED');
    const isOriginal = new URL(request.url).searchParams.get('original') === '1';
    if (!isOriginal && (row.job.state !== 'completed' || !row.job.outputKey))
      throw new ServiceError(409, 'NOT_READY');
    const query = new URL(request.url).searchParams;
    const preview =
      query.get('preview') === '1'
        ? isOriginal
          ? row.job.inputPreview
          : row.job.outputPreview
        : null;
    return {
      url: await downloadUrl(
        preview?.key || (isOriginal ? row.asset.key : row.job.outputKey!),
        isOriginal ? row.asset.name : row.job.outputName || outputFilename(row.asset.name),
        query.get('inline') === '1',
        preview?.mime ||
          (isOriginal ? mimeForName(row.asset.name) : row.job.outputMime || 'video/mp4'),
      ),
    };
  }
  throw new ServiceError(404, 'NOT_FOUND');
});
export const POST = api(async (request, path, owner) => {
  if (path.join('/') === 'billing/checkout') {
    const body = z
      .object({ pack: z.enum(['basic', 'pro', 'premium']) })
      .strict()
      .parse(await jsonBody(request));
    const overview = await billingOverview(owner, 1);
    if (!waffoOverview(overview.salesEnabled).enabled)
      throw new ServiceError(503, 'PAYMENT_NOT_ENABLED');
    return createWaffoCheckout(owner, body.pack);
  }
  if (path[0] === 'jobs' && path.length === 4 && path[2] === 'watermark' && path[3] === 'runs')
    return createWatermarkRun(idSchema.parse(path[1]), owner, await jsonBody(request));
  if (path[0] === 'watermark-runs' && path.length === 3 && ['cancel', 'retry'].includes(path[2]))
    return changeWatermarkRun(idSchema.parse(path[1]), owner, path[2] as 'cancel' | 'retry');

  if (path[0] === 'jobs' && path[2] === 'reading' && path.length === 3)
    return createReading(idSchema.parse(path[1]), owner, await jsonBody(request));
  if (
    path[0] === 'reading-activities' &&
    path.length === 3 &&
    ['retry', 'cancel'].includes(path[2])
  )
    return changeReading(idSchema.parse(path[1]), owner, path[2] as 'retry' | 'cancel');
  if (path[0] === 'jobs' && path[2] === 'translation' && path.length === 4) {
    const id = idSchema.parse(path[1]);
    if (path[3] === 'exports') return createTranslationExport(id, owner, await jsonBody(request));
    if (path[3] === 'retry') return retryTranslationBlocks(id, owner, await jsonBody(request));
  }
  if (
    path[0] === 'translation-exports' &&
    path.length === 3 &&
    ['retry', 'cancel'].includes(path[2])
  )
    return changeTranslationExport(idSchema.parse(path[1]), owner, path[2] as 'retry' | 'cancel');
  if (path[0] === 'jobs' && path.length === 4 && path[2] === 'transcript' && path[3] === 'exports')
    return createTranscriptExport(idSchema.parse(path[1]), owner, await jsonBody(request));
  if (
    path[0] === 'transcript-exports' &&
    path.length === 3 &&
    ['cancel', 'retry'].includes(path[2])
  )
    return changeTranscriptExport(idSchema.parse(path[1]), owner, path[2] as 'cancel' | 'retry');

  if (path[0] === 'assets' && path.length === 3 && path[2] === 'prepare') {
    const body = z
      .object({
        profile: z.enum(['video', 'audio']),
        streamIndex: z.number().int().min(-1).max(255).default(-1),
        retry: z.boolean().default(false),
      })
      .strict()
      .parse(await jsonBody(request));
    await prepareAsset(owner, idSchema.parse(path[1]), body.profile, body.streamIndex, body.retry);
    return preparationView(owner, path[1], body.profile, body.streamIndex);
  }
  if (path.join('/') === 'batches') {
    const body = z
      .object({
        tool: batchToolSchema,
        assetIds: z.array(idSchema).min(1).max(20),
        requestId: idSchema,
        options: z.unknown(),
      })
      .strict()
      .parse(await jsonBody(request));
    const spec = jobSpecSchema.parse(body);
    await assertToolPublished(body.tool);
    const batch = await createBatch(owner, body.assetIds, body.requestId, body.tool, spec.options);
    return { id: batch.id };
  }
  if (path[0] === 'batches' && path.length === 3) {
    const id = idSchema.parse(path[1]);
    if (path[2] === 'archive') {
      const archive = await createArchive(id, owner);
      return { id: archive.id };
    }
    if (path[2] === 'cancel' || path[2] === 'retry') {
      await changeBatch(id, owner, path[2]);
      return { batch: await batchForOwner(id, owner) };
    }
  }
  if (path.join('/') === 'uploads') {
    const mode = (await billingConfig()).settings.mode;
    if (
      mode === 'shadow' &&
      process.env.NODE_ENV === 'production' &&
      process.env.BILLING_SHADOW_EXECUTION !== 'true'
    )
      throw new ServiceError(503, 'BILLING_PREVIEW_ONLY');
    if (mode === 'enforced') {
      if (!owner.startsWith('user:')) throw new ServiceError(401, 'BILLING_LOGIN_REQUIRED');
      if ((await account(owner)).available < 1) throw new ServiceError(402, 'INSUFFICIENT_CREDITS');
    }
    const data = z
      .object({ name: z.string().min(1).max(240), size: z.number().int().positive() })
      .strict()
      .parse(await jsonBody(request));
    return createUpload(owner, data.name, data.size);
  }
  if (path[0] === 'uploads' && path.length === 3) {
    const id = idSchema.parse(path[1]);
    if (path[2] === 'parts') {
      const body = z
        .object({ partNumber: z.number().int().positive() })
        .strict()
        .parse(await jsonBody(request));
      return uploadPart(id, owner, body.partNumber);
    }
    if (path[2] === 'complete') return completeUpload(id, owner);
  }
  if (path.join('/') === 'quote') {
    const body = await jsonBody(request);
    // Keep the original single-file quote input while adding all ancillary operations.
    return createQuote(owner, body.operation || { path: 'jobs', body });
  }
  if (path.join('/') === 'jobs') {
    const body = z
      .object({
        assetId: idSchema.optional(),
        assetIds: z.array(idSchema).min(1).max(20).optional(),
        purpose: z.enum(['export', 'preview']).default('export'),
        requestId: idSchema,
        tool: toolSchema.default('video-compressor'),
        options: z.unknown(),
      })
      .strict()
      .parse(await jsonBody(request));
    const spec = jobSpecSchema.parse(body);
    await assertToolPublished(body.tool);
    if (!!body.assetId === !!body.assetIds) throw new ServiceError(400, 'INVALID_SOURCES');
    const ids = body.assetIds || [body.assetId!];
    const job = await createJob(
      owner,
      ids[0],
      body.requestId,
      spec.options,
      body.tool,
      ids,
      body.purpose,
    );
    return { id: job.id };
  }
  if (path[0] === 'jobs' && path.length === 3 && ['cancel', 'retry'].includes(path[2])) {
    const id = idSchema.parse(path[1]);
    await changeJob(id, owner, path[2] as 'cancel' | 'retry');
    return { job: jobView(await jobForOwner(id, owner)) };
  }
  throw new ServiceError(404, 'NOT_FOUND');
});
export const DELETE = api(async (_request, path, owner) => {
  if (path[0] === 'batches' && path.length === 2) {
    await changeBatch(idSchema.parse(path[1]), owner, 'delete');
    return { deleted: true };
  }
  if (path[0] === 'jobs' && path.length === 2) {
    await changeJob(idSchema.parse(path[1]), owner, 'delete');
    return { deleted: true };
  }
  if (path[0] === 'uploads' && path.length === 2) {
    const id = idSchema.parse(path[1]);
    const asset = await assetForOwner(id, owner);
    if (asset.state === 'ready') throw new ServiceError(409, 'UPLOAD_ALREADY_COMPLETED');
    await db()
      .update(assets)
      .set({ state: 'deleting' })
      .where(and(eq(assets.id, id), eq(assets.owner, owner), gt(assets.expiresAt, new Date())));
    return { deleted: true };
  }
  throw new ServiceError(404, 'NOT_FOUND');
});

export const PATCH = api(async (request, path, owner) => {
  if (path[0] === 'jobs' && path.length === 3 && path[2] === 'watermark')
    return saveWatermark(idSchema.parse(path[1]), owner, await jsonBody(request, 2 * 1024 ** 2));

  if (path[0] === 'jobs' && path.length === 3 && path[2] === 'translation')
    return patchTranslation(idSchema.parse(path[1]), owner, await jsonBody(request, 2 * 1024 ** 2));
  if (path[0] === 'jobs' && path.length === 3 && path[2] === 'transcript')
    return patchTranscript(idSchema.parse(path[1]), owner, await jsonBody(request));
  throw new ServiceError(404, 'NOT_FOUND');
});
