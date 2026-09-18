// Isolated process owned by check-watermarks-resilience.ts; never calls cloud providers.
import { processWatermark } from '../apps/worker/src/watermark-worker';
import {
  translationProvider,
  type TranslationProvider,
} from '../apps/worker/src/translation-provider';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sqlClient } from '@filemorph/core/db';
import { abortableWait } from '../apps/worker/src/ai-rate-limit';
const [id, attempt, kind, mode] = process.argv.slice(2),
  root = resolve('.data/watermark-test/recovery-temp');
await mkdir(root, { recursive: true });
const provider: TranslationProvider = {
  ...translationProvider,
  async repair(file, signal, route) {
    await route.onSending?.();
    await appendFile(resolve('.data/watermark-test/recovery-calls.txt'), id + '\n');
    if (mode === 'slow') await abortableWait(300000, signal);
    return {
      result: { url: 'data:image/png;base64,' + (await readFile(file)).toString('base64') },
      requestId: 'fixture-' + id,
    };
  },
};
try {
  await processWatermark(
    id,
    Number(attempt),
    kind as 'analyze' | 'run',
    new Set(),
    new Set(),
    root,
    provider,
  );
} finally {
  await sqlClient().end();
}
