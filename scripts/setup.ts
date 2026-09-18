import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { sqlClient } from '@filemorph/core/db';
import { s3 } from '@filemorph/core/storage';
import { bucket } from '@filemorph/core/config';
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
if (
  !['127.0.0.1', 'localhost'].includes(new URL(process.env.S3_ENDPOINT!).hostname) ||
  !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL!).hostname)
)
  throw new Error(
    'setup:local is for local services only. See docs/operations.md for cloud configuration.',
  );
if (!process.env.BETTER_AUTH_SECRET) {
  const path = new URL('../.env', import.meta.url);
  const contents = await readFile(path, 'utf8');
  const entry = `BETTER_AUTH_SECRET=${randomBytes(48).toString('base64url')}`;
  await writeFile(
    path,
    /^BETTER_AUTH_SECRET=.*$/m.test(contents)
      ? contents.replace(/^BETTER_AUTH_SECRET=.*$/m, entry)
      : `${contents.trimEnd()}\n${entry}\n`,
    { mode: 0o600 },
  );
  console.log('Generated the local Better Auth secret. Restart web to load it.');
}
const client = sqlClient();
try {
  await client.unsafe(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7826431)`;
      if ((await tx`SELECT name FROM schema_migrations WHERE name=${name}`).length) return;
      await tx.unsafe(await readFile(new URL(name, directory), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
  }
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
      throw error;
    await s3().send(new CreateBucketCommand({ Bucket: bucket() }));
  }
  await s3()
    .send(
      new PutBucketCorsCommand({
        Bucket: bucket(),
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [new URL(process.env.APP_URL!).origin, 'http://127.0.0.1:3000'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    )
    .catch((error) => {
      if (
        process.env.S3_ENDPOINT?.includes('127.0.0.1') &&
        (error as { name: string }).name === 'NotImplemented'
      )
        console.log('Local storage uses CORS from compose.yaml.');
      else throw error;
    });
  console.log('Database and private object storage are ready.');
} finally {
  await client.end();
}
