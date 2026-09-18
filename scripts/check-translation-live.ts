import { mkdir, writeFile } from 'node:fs/promises';
import { translationProvider } from '../apps/worker/src/translation-provider';
import { translationRoute } from '@filemorph/core/translation';
const output = '.data/translation-live';
await mkdir(output, { recursive: true });
for (const kind of ['translate', 'ocr', 'repair'] as const) {
  if (process.argv[2] && process.argv[2] !== kind) continue;
  try {
    const route = translationRoute(kind),
      signal = AbortSignal.timeout(300000);
    const result =
      kind === 'translate'
        ? await translationProvider.translate(
            'Welcome to FormatOwl. Keep your files organized.',
            'en',
            'zh',
            signal,
            route,
          )
        : kind === 'ocr'
          ? await translationProvider.ocr(
              '.data/translation-fixtures/menu.png',
              800,
              500,
              signal,
              route,
            )
          : await translationProvider.repair('.data/translation-fixtures/menu.png', signal, route);
    await writeFile(`${output}/${kind}.json`, JSON.stringify(result, null, 2));
    console.log(kind, 'OK', result.requestId || '');
  } catch (e) {
    process.exitCode = 1;
    console.log(kind, 'FAILED', e instanceof Error ? e.message : 'error');
  }
}
