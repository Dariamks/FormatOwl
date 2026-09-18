import type { EditorMedia, EditResultInfo } from './editing';
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  primaryKey,
  index,
  boolean,
  doublePrecision,
  numeric,
} from 'drizzle-orm/pg-core';
import type {
  ToolOptions,
  JobState,
  FileInfo,
  Tool,
  BatchTool,
  PreviewFile,
  ResultNote,
} from './domain';

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminSessions = pgTable(
  'admin_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    username: text('username').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('admin_sessions_expiry_idx').on(table.expiresAt)],
);

export const adminUserProfiles = pgTable('admin_user_profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  blocked: boolean('blocked').notNull().default(false),
  blockedReason: text('blocked_reason'),
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminRecharges = pgTable(
  'admin_recharges',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    receipt: text('receipt').notNull().unique(),
    amountCny: numeric('amount_cny', { precision: 12, scale: 2 }).notNull(),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    note: text('note'),
    adminUsername: text('admin_username').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('admin_recharges_user_idx').on(table.userId, table.createdAt)],
);

export const toolVisibility = pgTable('tool_visibility', {
  toolId: text('tool_id').primaryKey(),
  published: boolean('published').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guestClaims = pgTable('guest_claims', {
  owner: text('owner').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    owner: text('owner').notNull(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    uploadId: text('upload_id'),
    state: text('state').notNull().default('uploading'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('assets_owner_idx').on(table.owner)],
);
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    owner: text('owner').notNull(),
    requestId: uuid('request_id').notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    tool: text('tool').$type<Tool>().notNull().default('video-compressor'),
    batchId: uuid('batch_id'),
    purpose: text('purpose').$type<'export' | 'preview'>().notNull().default('export'),
    sourceIds: jsonb('source_ids').$type<string[]>().notNull().default([]),
    inputSize: bigint('input_size', { mode: 'number' }),
    inputMedia: jsonb('input_media').$type<{ id: string; media: EditorMedia }[]>(),
    outputMedia: jsonb('output_media').$type<EditResultInfo>(),
    outputName: text('output_name'),
    outputMime: text('output_mime'),
    inputPreview: jsonb('input_preview').$type<PreviewFile>(),
    outputPreview: jsonb('output_preview').$type<PreviewFile>(),
    note: text('note').$type<ResultNote>(),
    state: text('state').$type<JobState>().notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    options: jsonb('options').$type<ToolOptions>().notNull(),
    attempt: integer('attempt').notNull().default(1),
    outputKey: text('output_key'),
    outputSize: bigint('output_size', { mode: 'number' }),
    media: jsonb('media').$type<FileInfo>(),
    error: text('error'),
    errorDetail: text('error_detail'),
    deleting: boolean('deleting').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_idx').on(table.owner, table.requestId),
    index('jobs_owner_idx').on(table.owner),
    index('jobs_expiry_idx').on(table.expiresAt),
  ],
);
export const outbox = pgTable('outbox', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
});

export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey(),
    owner: text('owner').notNull(),
    requestId: uuid('request_id').notNull(),
    tool: text('tool').$type<BatchTool>().notNull(),
    assetIds: jsonb('asset_ids').$type<string[]>().notNull(),
    options: jsonb('options').$type<ToolOptions>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('batches_request_idx').on(t.owner, t.requestId)],
);
export interface ArchiveMember {
  id: string;
  attempt: number;
  key: string;
  name: string;
}
export const archives = pgTable('archives', {
  id: uuid('id').primaryKey(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => batches.id),
  version: text('version').notNull(),
  members: jsonb('members').$type<ArchiveMember[]>().notNull(),
  state: text('state').notNull().default('queued'),
  key: text('key').notNull(),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const jobInputs = pgTable('job_inputs', {
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id')
    .notNull()
    .references(() => assets.id),
});
export const preparations = pgTable('preparations', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  assetId: uuid('asset_id')
    .notNull()
    .references(() => assets.id),
  profile: text('profile').$type<'video' | 'audio'>().notNull(),
  streamIndex: integer('stream_index').notNull().default(-1),
  state: text('state').notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  attempt: integer('attempt').notNull().default(1),
  media: jsonb('media').$type<EditorMedia>(),
  previewKey: text('preview_key'),
  peaksKey: text('peaks_key'),
  thumbnailsKey: text('thumbnails_key'),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const transcripts = pgTable('transcripts', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  data: jsonb('data').$type<import('./transcription').TranscriptData>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const transcriptionChunks = pgTable(
  'transcription_chunks',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    index: integer('chunk_index').notNull(),
    range: jsonb('range').$type<import('./transcription').ChunkRange>().notNull(),
    state: text('state').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    claim: uuid('claim'),
    requestId: text('request_id'),
    providerConfig:
      jsonb('provider_config').$type<import('./transcription').TranscriptionProviderConfig>(),
    providerTaskId: text('provider_task_id'),
    result: jsonb('result').$type<{
      segments: import('./transcription').TranscriptSegment[];
      speakers: import('./transcription').TranscriptSpeaker[];
    }>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transcription_chunk_index').on(t.jobId, t.index)],
);
export const transcriptExports = pgTable('transcript_exports', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  format: text('format').notNull(),
  options: jsonb('options').$type<import('./transcription').TranscriptExportOptions>().notNull(),
  snapshot: jsonb('snapshot').$type<import('./transcription').TranscriptData>().notNull(),
  state: text('state').notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  key: text('key'),
  name: text('name'),
  mime: text('mime'),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const translationDocuments = pgTable('translation_documents', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  data: jsonb('data').$type<import('./translation').TranslationData>(),
  stage: text('stage').notNull().default('queued'),
  completedUnits: integer('completed_units').notNull().default(0),
  totalUnits: integer('total_units').notNull().default(0),
  operation: jsonb('operation').$type<{ operation: 'translate' | 'repair'; blockIds: string[] }>(),
  waitingUntil: timestamp('waiting_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const translationSteps = pgTable(
  'translation_steps',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    state: text('state').notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    providerConfig: jsonb('provider_config').$type<import('./translation').TranslationRoute>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.stepKey] })],
);
export const translationExports = pgTable('translation_exports', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  options: jsonb('options').$type<import('./translation').TranslationExportOptions>().notNull(),
  snapshot: jsonb('snapshot').$type<import('./translation').TranslationData>().notNull(),
  state: text('state').notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  key: text('key'),
  name: text('name'),
  mime: text('mime'),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const workerCapabilities = pgTable('worker_capabilities', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Record<string, boolean>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const translationActivities = pgTable('translation_activities', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<import('./reading').ReadingOptions['kind']>().notNull(),
  revision: integer('revision').notNull(),
  contentHash: text('content_hash').notNull(),
  options: jsonb('options').$type<import('./reading').ReadingOptions>().notNull(),
  snapshot: jsonb('snapshot').$type<import('./translation').TranslationData>().notNull(),
  history: jsonb('history')
    .$type<{ question: string; answer: import('./reading').ReadingResult }[]>()
    .notNull()
    .default([]),
  result: jsonb('result').$type<
    import('./reading').ReadingResult | import('./reading').PreviewResult
  >(),
  state: text('state').notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  completedUnits: integer('completed_units').notNull().default(0),
  totalUnits: integer('total_units').notNull().default(0),
  waitingUntil: timestamp('waiting_until', { withTimezone: true }),
  error: text('error'),
  files: jsonb('files')
    .$type<Record<string, { key: string; mime: string; name: string }>>()
    .notNull()
    .default({}),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const watermarkDocuments = pgTable('watermark_documents', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  data: jsonb('data').$type<import('./watermark').WatermarkData>(),
  selection: jsonb('selection')
    .$type<import('./watermark').WatermarkSelection>()
    .notNull()
    .default({ candidates: [], regions: [] }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const watermarkRuns = pgTable(
  'watermark_runs',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    revision: integer('revision').notNull(),
    options: jsonb('options').$type<import('./watermark').WatermarkRunOptions>().notNull(),
    snapshot: jsonb('snapshot')
      .$type<{
        data: import('./watermark').WatermarkData;
        selection: import('./watermark').WatermarkSelection;
      }>()
      .notNull(),
    state: text('state').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    result: jsonb('result').$type<{
      file?: string;
      name?: string;
      mime?: string;
      pages: { index: number; file: string }[];
    }>(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watermark_runs_request_idx').on(t.jobId, t.requestId)],
);
export const watermarkSteps = pgTable(
  'watermark_steps',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    state: text('state').notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    providerConfig: jsonb('provider_config').$type<import('./translation').TranslationRoute>(),
    requestId: text('request_id'),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.stepKey] })],
);

export const billingPriceBooks = pgTable('billing_price_books', {
  version: text('version').primaryKey(),
  data: jsonb('data').$type<import('./billing-model').PriceBook>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const billingSettings = pgTable('billing_settings', {
  id: text('id').primaryKey(),
  evidence: text('evidence'),
  mode: text('mode').$type<import('./billing-model').BillingMode>().notNull().default('shadow'),
  priceVersion: text('price_version'),
  paymentVerified: boolean('payment_verified').notNull().default(false),
  paymentFeeRate: numeric('payment_fee_rate'),
  paymentFixedCny: numeric('payment_fixed_cny'),
  productionVerified: boolean('production_verified').notNull().default(false),
  salesEnabled: boolean('sales_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const creditAccounts = pgTable('credit_accounts', {
  owner: text('owner').primaryKey(),
  available: bigint('available', { mode: 'number' }).notNull().default(0),
  reserved: bigint('reserved', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const billingProbes = pgTable('billing_probes', {
  assetId: uuid('asset_id')
    .primaryKey()
    .references(() => assets.id),
  owner: text('owner').notNull(),
  state: text('state').notNull().default('queued'),
  facts: jsonb('facts').$type<import('./billing-model').BillingFacts>(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export interface BillingSnapshot {
  book: import('./billing-model').PriceBook;
  lines: import('./billing-model').QuoteLine[];
  missingPrices: string[];
  stage: string;
  allowedStages: string[];
  warnings: string[];
  maxTargets: number;
  assetIds: string[];
  factsHash: string;
}
export const billingQuotes = pgTable('billing_quotes', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  fingerprint: text('fingerprint').notNull(),
  operation: jsonb('operation').$type<{ path: string; body: Record<string, unknown> }>().notNull(),
  snapshot: jsonb('snapshot').$type<BillingSnapshot>().notNull(),
  mode: text('mode').$type<import('./billing-model').BillingMode>().notNull(),
  state: text('state').notNull(),
  estimatedCredits: bigint('estimated_credits', { mode: 'number' }),
  maximumCredits: bigint('maximum_credits', { mode: 'number' }),
  knownCredits: bigint('known_credits', { mode: 'number' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const billingOperations = pgTable('billing_operations', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  quoteId: uuid('quote_id')
    .unique()
    .references(() => billingQuotes.id),
  mode: text('mode').$type<import('./billing-model').BillingMode>().notNull(),
  state: text('state').notNull().default('open'),
  priceBook: jsonb('price_book').$type<import('./billing-model').PriceBook>().notNull(),
  reservedCredits: bigint('reserved_credits', { mode: 'number' }).notNull().default(0),
  chargedCredits: bigint('charged_credits', { mode: 'number' }).notNull().default(0),
  maximumMicroCny: bigint('maximum_micro_cny', { mode: 'number' }),
  allowedStages: jsonb('allowed_stages').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const billingTargets = pgTable('billing_targets', {
  key: text('key').primaryKey(),
  operationId: uuid('operation_id')
    .notNull()
    .references(() => billingOperations.id),
  kind: text('kind').notNull(),
  targetId: uuid('target_id').notNull(),
  attempt: integer('attempt').notNull().default(1),
  state: text('state').notNull().default('pending'),
  error: text('error'),
});
export const costUsage = pgTable('cost_usage', {
  id: uuid('id').primaryKey(),
  operationId: uuid('operation_id').references(() => billingOperations.id),
  targetKey: text('target_key'),
  eventKey: text('event_key').notNull().unique(),
  meter: text('meter').$type<import('./billing-model').Meter>().notNull(),
  stage: text('stage').notNull(),
  rateId: text('rate_id'),
  route: text('route'),
  model: text('model'),
  requestId: text('request_id'),
  quantity: doublePrecision('quantity').notNull().default(0),
  maximumQuantity: doublePrecision('maximum_quantity').notNull().default(0),
  rawUsage: jsonb('raw_usage').$type<Record<string, unknown>>(),
  costMicroCny: bigint('cost_micro_cny', { mode: 'number' }),
  maximumMicroCny: bigint('maximum_micro_cny', { mode: 'number' }),
  category: text('category').notNull().default('variable'),
  verified: boolean('verified').notNull().default(false),
  state: text('state').notNull().default('started'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').primaryKey(),
  owner: text('owner')
    .notNull()
    .references(() => creditAccounts.owner),
  operationId: uuid('operation_id').references(() => billingOperations.id),
  kind: text('kind').notNull(),
  availableDelta: bigint('available_delta', { mode: 'number' }).notNull(),
  reservedDelta: bigint('reserved_delta', { mode: 'number' }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const billingAlerts = pgTable('billing_alerts', {
  key: text('key').primaryKey(),
  operationId: uuid('operation_id').references(() => billingOperations.id),
  kind: text('kind').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
