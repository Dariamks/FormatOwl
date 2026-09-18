import { it, expect } from 'vitest';
import { mkdtemp, mkdir, utimes, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTemporaryFiles } from '@filemorph/core/temp';

it('cleans crash leftovers while preserving active, fresh, unrelated and symlinked paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'filemorph-cleanup-test-'));
  try {
    for (const name of ['job-stale', 'job-active', 'job-fresh', 'unrelated']) {
      await mkdir(join(root, name));
      if (name !== 'job-fresh') await utimes(join(root, name), new Date(0), new Date(0));
    }
    await symlink(join(root, 'unrelated'), join(root, 'job-link'));
    await cleanTemporaryFiles(root, Date.now() - 60000, new Set([join(root, 'job-active')]));
    await expect(access(join(root, 'job-stale'))).rejects.toThrow();
    for (const name of ['job-active', 'job-fresh', 'unrelated', 'job-link']) {
      await expect(access(join(root, name))).resolves.toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
