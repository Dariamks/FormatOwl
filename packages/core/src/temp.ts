import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove only stale FormatOwl directories, never active work or unrelated files. */
export async function cleanTemporaryFiles(root: string, cutoff: number, active: Set<string>) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || !entry.name.startsWith('job-') || active.has(path)) continue;
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
