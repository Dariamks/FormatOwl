import { startUsage, completeUsage, unknownUsage } from './billing-usage';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { bucket, storageConfig } from './config';
let client: S3Client;
export function s3() {
  return (client ||= new S3Client(storageConfig()));
}
export async function beginUpload(key: string) {
  const result = await s3().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: 'application/octet-stream',
    }),
  );
  if (!result.UploadId) throw new Error('Storage did not return an upload ID');
  return result.UploadId;
}
export async function signPart(key: string, uploadId: string, partNumber: number, size: number) {
  return getSignedUrl(
    s3(),
    new UploadPartCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: size,
    }),
    { expiresIn: 900, signableHeaders: new Set(['content-length']) },
  );
}
export async function listParts(key: string, uploadId: string) {
  const result = await s3().send(
    new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }),
  );
  return result.Parts || [];
}
export async function finishUpload(
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
) {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
}
export async function abortUpload(key: string, uploadId: string) {
  try {
    await s3().send(
      new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }),
    );
  } catch (error) {
    if ((error as { name: string }).name !== 'NoSuchUpload') throw error;
  }
}
export async function headObject(key: string) {
  return s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
}
export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
export async function downloadUrl(
  key: string,
  filename: string,
  inline = false,
  mime = 'video/mp4',
  expiresIn = 900,
) {
  const safe = filename.replace(/[\r\n"\\]/g, '_');
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentType: mime,
      ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    }),
    { expiresIn: Math.max(1, Math.min(900, Math.floor(expiresIn))) },
  );
}
export async function downloadToFile(key: string, path: string, signal: AbortSignal) {
  const readMeter = await startUsage({ meter: 'storage_read', stage: 'storage', maximum: 1 });
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    abortSignal: signal,
  });
  await completeUsage(readMeter, 1);
  if (!result.Body) throw new Error('Empty object');
  let transfer: string | null;
  try {
    transfer = await startUsage({
      meter: 'transfer_gib',
      stage: 'storage',
      maximum: (result.ContentLength || 0) / 1024 ** 3,
    });
  } catch (error) {
    (result.Body as Readable).destroy();
    throw error;
  }
  let bytes = 0;
  (result.Body as Readable).on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    await pipeline(result.Body as Readable, createWriteStream(path), { signal });
  } finally {
    await completeUsage(transfer, bytes / 1024 ** 3);
  }
}
export async function uploadFromFile(
  key: string,
  path: string,
  signal: AbortSignal,
  mime = 'video/mp4',
) {
  const info = await stat(path);
  const writeMeter = await startUsage({ meter: 'storage_write', stage: 'storage', maximum: 1 });
  let transfer: string | null = null,
    retention: string | null = null;
  try {
    transfer = await startUsage({
      meter: 'transfer_gib',
      stage: 'storage',
      maximum: info.size / 1024 ** 3,
    });
    retention = await startUsage({
      meter: 'storage_gib_day',
      stage: 'storage',
      maximum: info.size / 1024 ** 3,
    });
  } catch (error) {
    await completeUsage(writeMeter, 0);
    await completeUsage(transfer, 0);
    throw error;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: createReadStream(path),
      ContentLength: info.size,
      ContentType: mime,
    }),
    { abortSignal: signal },
  );
  await completeUsage(writeMeter, 1);
  await completeUsage(transfer, info.size / 1024 ** 3);
  await completeUsage(retention, info.size / 1024 ** 3, {
    measurement: '24h_retention_allocation',
  });
  return info.size;
}

export async function deletePrefix(prefix: string) {
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents || []) if (object.Key) await deleteObject(object.Key);
    token = page.NextContinuationToken;
  } while (token);
}
export async function objectStream(key: string, signal: AbortSignal) {
  const readMeter = await startUsage({ meter: 'storage_read', stage: 'storage', maximum: 1 });
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    abortSignal: signal,
  });
  await completeUsage(readMeter, 1);
  if (!result.Body) throw new Error('Missing object');
  const source = result.Body as Readable;
  let transfer: string | null;
  try {
    transfer = await startUsage({
      meter: 'transfer_gib',
      stage: 'storage',
      maximum: (result.ContentLength || 0) / 1024 ** 3,
    });
  } catch (error) {
    source.destroy();
    throw error;
  }
  let bytes = 0;
  const metered = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      void completeUsage(transfer, bytes / 1024 ** 3).then(() => callback(), callback);
    },
    destroy(error, callback) {
      void completeUsage(transfer, bytes / 1024 ** 3).then(
        () => callback(error),
        (e) => callback(e),
      );
    },
  });
  source.on('error', (error) => metered.destroy(error));
  metered.on('close', () => source.destroy());
  return source.pipe(metered);
}
export async function uploadStream(
  key: string,
  stream: Readable,
  signal: AbortSignal,
  mime: string,
  maximumBytes: number,
) {
  const tickets: (string | null)[] = [];
  const parts = Math.ceil(maximumBytes / (8 * 1024 * 1024)) + 2;
  try {
    tickets.push(await startUsage({ meter: 'storage_write', stage: 'storage', maximum: parts }));
    tickets.push(
      await startUsage({
        meter: 'transfer_gib',
        stage: 'storage',
        maximum: maximumBytes / 1024 ** 3,
      }),
    );
    tickets.push(
      await startUsage({
        meter: 'storage_gib_day',
        stage: 'storage',
        maximum: maximumBytes / 1024 ** 3,
      }),
    );
  } catch (error) {
    for (const id of tickets) await completeUsage(id, 0);
    throw error;
  }
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) callback(new Error('Archive exceeded reserved bytes'));
      else callback(null, chunk);
    },
  });
  stream.on('error', (error) => counter.destroy(error));
  stream.pipe(counter);
  const upload = new Upload({
    client: s3(),
    params: { Bucket: bucket(), Key: key, Body: counter, ContentType: mime },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  const abort = () => {
    stream.destroy();
    void upload.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await upload.done();
    await completeUsage(
      tickets[0],
      bytes <= 8 * 1024 * 1024 ? 1 : Math.ceil(bytes / (8 * 1024 * 1024)) + 2,
      { measurement: 'multipart_request_allocation' },
    );
    await completeUsage(tickets[1], bytes / 1024 ** 3);
    await completeUsage(tickets[2], bytes / 1024 ** 3, { measurement: '24h_retention_allocation' });
  } catch (error) {
    await unknownUsage(tickets, 'STORAGE_OUTCOME_UNKNOWN');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
