import { readFile, readdir } from 'node:fs/promises';
import { sqlClient } from '@filemorph/core/db';
import { s3 } from '@filemorph/core/storage';
import { bucket } from '@filemorph/core/config';
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for production migrations');

const storageConfigReady = [
  'APP_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_BUCKET',
].every((name) => process.env[name]);

const client = sqlClient();
try {
  await client.unsafe(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7826431)`;
      if ((await tx`SELECT name FROM schema_migrations WHERE name=${name}`).length) return;
      await tx.unsafe(await readFile(new URL(name, directory), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.log(`Applied migration ${name}`);
  }

  if (storageConfigReady) {
    const appUrl = process.env.APP_URL!;
    try {
      await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
        throw error;
      await s3().send(new CreateBucketCommand({ Bucket: bucket() }));
    }
    await s3().send(
      new PutBucketCorsCommand({
        Bucket: bucket(),
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [new URL(appUrl).origin],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log('Production database migrations and storage CORS are ready.');
  } else {
    console.warn(
      'Database migrations are ready. Skipping storage bucket setup because production S3 variables are incomplete.',
    );
  }
} finally {
  await client.end();
}
