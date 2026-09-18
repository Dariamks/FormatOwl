import { fileTool, maxFileSize } from '@filemorph/core/domain';
import Uppy, { type Meta } from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import { ApiError, request } from './client-api';
export interface UploadSession {
  id: string;
  partSize: number;
  state: string;
  parts: { PartNumber: number; Size: number; ETag: string }[];
}
const storageKey = 'filemorph-upload-v1';
// Parallel first uploads must share the same anonymous-session handshake.
let sessionRequest: Promise<unknown> | undefined;
interface SavedUpload {
  fingerprint: string;
  id: string;
  createdAt: number;
}
function readSaved(): SavedUpload[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '[]');
  } catch {
    return [];
  }
}
function saveSaved(value: SavedUpload[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* Upload still works when browser storage is unavailable. */
  }
}
export function forgetUpload(id: string) {
  saveSaved(
    readSaved().filter((item) => item.id !== id && item.createdAt > Date.now() - 86400_000),
  );
}
export function releaseUploader(uppy: Uppy) {
  uppy.pauseAll();
  const plugin = uppy.getPlugin<AwsS3<Meta, Record<string, never>>>('AwsS3Multipart');
  for (const file of uppy.getFiles()) plugin?.resetUploaderReferences(file.id);
  uppy.destroy();
}
async function fingerprint(file: File) {
  const sample = new Blob([
    `${file.name}:${file.size}:${file.lastModified}`,
    file.slice(0, 65536),
    file.slice(-65536),
  ]);
  const hash = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  return Array.from(new Uint8Array(hash))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function makeUploader(
  file: File,
  progress: (value: number) => void,
  partConcurrency = 3,
): Promise<{ uppy: Uppy; assetId: string; ready: boolean }> {
  await (sessionRequest ??= request('session').finally(() => {
    sessionRequest = undefined;
  }));
  const hash = await fingerprint(file),
    saved = readSaved().find((v) => v.fingerprint === hash && v.createdAt > Date.now() - 86400_000);
  let session: UploadSession | undefined;
  if (saved) {
    try {
      session = await request<UploadSession>(`uploads/${saved.id}`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      forgetUpload(saved.id);
    }
  }
  session ??= await request<UploadSession>('uploads', { name: file.name, size: file.size });
  const assetId = session.id;
  saveSaved(
    [
      ...readSaved().filter((v) => v.fingerprint !== hash && v.createdAt > Date.now() - 86400_000),
      { fingerprint: hash, id: assetId, createdAt: Date.now() },
    ].slice(-20),
  );
  const uppy = new Uppy({
    autoProceed: false,
    restrictions: {
      maxNumberOfFiles: 1,
      maxFileSize: maxFileSize(fileTool(file.name) || 'video-compressor'),
    },
    allowMultipleUploadBatches: false,
  });
  uppy.use(AwsS3, {
    shouldUseMultipart: true,
    limit: partConcurrency,
    getChunkSize: () => session!.partSize,
    retryDelays: [0, 1000, 3000, 5000],
    createMultipartUpload: async () => ({ uploadId: assetId, key: assetId }),
    signPart: async (_file, { partNumber }) => ({
      method: 'PUT',
      ...(await request<{ url: string }>(`uploads/${assetId}/parts`, { partNumber })),
    }),
    listParts: async () => (await request<UploadSession>(`uploads/${assetId}`)).parts,
    completeMultipartUpload: async () => {
      await request(`uploads/${assetId}/complete`, {});
      return {};
    },
    abortMultipartUpload: async () => {
      await request(`uploads/${assetId}`, undefined, 'DELETE');
      forgetUpload(assetId);
    },
  });
  const id = uppy.addFile({
    name: file.name,
    type: file.type || 'application/octet-stream',
    data: file,
  });
  // Restore the logical server upload ID. Uppy queries the authoritative uploaded parts.
  if (session.parts.length) {
    const state = { s3Multipart: { uploadId: assetId, key: assetId } };
    uppy.setFileState(id, { ...uppy.getFile(id), ...state });
  }
  uppy.on('upload-progress', (_file, event) => {
    progress(Math.round((100 * (event.bytesUploaded || 0)) / (event.bytesTotal || file.size)));
  });
  return { uppy, assetId, ready: session.state === 'ready' };
}
