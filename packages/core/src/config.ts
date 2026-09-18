function required(name: string) {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing ${name}. Copy .env.example to .env and run pnpm setup:local.`);
  return value;
}
export function databaseUrl() {
  return required('DATABASE_URL');
}
export function redisUrl() {
  return required('REDIS_URL');
}
export function storageConfig() {
  return {
    endpoint: required('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'auto',
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
}
export function bucket() {
  return required('S3_BUCKET');
}
export function sessionSecret() {
  const value = required('SESSION_SECRET');
  if (value.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return value;
}
export const limits = {
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 1073741824),
  partSize: 16 * 1024 * 1024,
  maxActiveJobs: 20,
  maxDailyUploads: 20,
  ttlMs: Number(process.env.FILE_TTL_HOURS || 24) * 3600_000,
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 3600_000),
};
