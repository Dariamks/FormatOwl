import { readFile, readdir } from 'node:fs/promises';
import { sqlClient } from '@filemorph/core/db';
import { s3 } from '@filemorph/core/storage';
import { bucket } from '@filemorph/core/config';
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const appUrl = process.env.APP_URL;
if (!appUrl) throw new Error('APP_URL is required for production migrations');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for production migrations');
if (!process.env.S3_ENDPOINT) throw new Error('S3_ENDPOINT is required for production migrations');

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
} finally {
  await client.end();
}
