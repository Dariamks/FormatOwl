import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { db, eq, sqlClient } from '@filemorph/core/db';
import { assets, jobs, jobInputs, transcripts, preparations } from '@filemorph/core/schema';
import { newSession } from '@filemorph/core/session';
import { sessionSecret } from '@filemorph/core/config';
import { uploadFromFile } from '@filemorph/core/storage';
import { probeEditor } from '../../apps/worker/src/processors/editor';
process.loadEnvFile(resolve('.env'));
test.afterAll(async () => {
  await sqlClient().end();
});
for (const scenario of [
  {
    tool: 'video-converter',
    input: resolve('.data/fixtures/sample.mp4'),
    format: 'MP4',
    kind: 'video',
    file: 'sample-formatowl.mp4',
    h265: true,
  },
  {
    tool: 'video-converter',
    input: 'video.mkv',
    format: 'WEBM',
    kind: 'video',
    file: 'video-formatowl.webm',
  },
  {
    tool: 'audio-converter',
    input: 'audio.flac',
    format: 'WAV',
    kind: 'audio',
    file: 'audio-formatowl.wav',
  },
  {
    tool: 'image-converter',
    input: 'photo.png',
    format: 'WEBP',
    kind: 'img',
    file: 'photo-formatowl.webp',
  },
])
  test(`${scenario.tool}${scenario.h265 ? ' H.265 60 fps' : ''} batch conversion, preview and ZIP`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/en/tools/${scenario.tool}`);
    await page
      .locator('input[type=file]')
      .setInputFiles(resolve('.data/conversion-checks/fixtures', scenario.input));
    await page.getByRole('combobox', { name: 'Output format', exact: true }).click();
    await page.getByRole('option', { name: scenario.format, exact: true }).click();
    if (scenario.h265) {
      // This longer encode produces fractional progress updates. Short fixtures can
      // finish before the worker persists any progress beyond the initial value.
      await page.getByRole('tab', { name: 'Advanced conversion' }).click();
      for (const [name, option] of [
        ['Video codec', 'H265'],
        ['Quality', 'Smaller file'],
        ['Frame rate', '60 fps'],
      ]) {
        await page.getByRole('combobox', { name, exact: true }).click();
        await page.getByRole('option', { name: option, exact: true }).click();
      }
    }
    await page.getByRole('button', { name: /Convert files/ }).click();
    await expect(page).toHaveURL(/\/en\/batches\//, { timeout: 60000 });
    await expect(page.getByText('1 of 1 files completed', { exact: true })).toBeVisible({
      timeout: 60000,
    });
    await page.reload();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const media = page.locator('.file-previews').locator(scenario.kind).last();
    if (scenario.kind === 'img') await expect(media).toHaveJSProperty('naturalWidth', 21);
    else await expect(media).toHaveJSProperty('readyState', 4);
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: /Download /, exact: false })
      .first()
      .click();
    expect((await download).suggestedFilename()).toBe(scenario.file);
    await page.getByRole('button', { name: 'Pack successful files' }).click();
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeEnabled({
      timeout: 30000,
    });
    const zip = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    expect((await zip).suggestedFilename()).toBe('formatowl-results.zip');
    expect(errors).toEqual([]);
    await page.screenshot({ path: `.data/${scenario.tool}-accepted.png`, fullPage: true });
    await page.request.delete(`/api/batches/${page.url().split('/').at(-1)}`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
  });
test('conversion controls and transcription configuration on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tool of ['video-converter', 'audio-converter', 'image-converter']) {
    await page.goto(`/zh/tools/${tool}`);
    await page.getByRole('tab', { name: '高级转换' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.goto('/zh/tools/transcription');
  const capabilities = await (await page.request.get('/api/capabilities')).json();
  if (!capabilities.transcription) {
    await expect(page.getByText(/转写待配置识别服务/)).toBeVisible();
    await expect(page.getByRole('button', { name: '开始转写' })).toBeDisabled();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('all four released tools open from the Chinese and English homepage', async ({ page }) => {
  for (const locale of ['zh', 'en']) {
    for (const tool of ['video-converter', 'audio-converter', 'image-converter', 'transcription']) {
      await page.goto(`/${locale}`);
      const card = page.locator(`.tool-card[href="/${locale}/tools/${tool}"]`);
      await expect(card.getByRole('heading', { level: 3 })).toBeVisible();
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/tools/${tool}$`));
      await expect(page.locator('input[type=file]')).toBeAttached();
    }
  }
});
test('transcript edits, pagination, export snapshots and conflict protection', async ({
  page,
  context,
}) => {
  await page.clock.install();
  const session = newSession(sessionSecret());
  await context.addCookies([
    {
      name: 'fm-session',
      value: session.token,
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const owner = session.owner;
  await page.goto('/en/workspace');
  const id = randomUUID(),
    assetId = randomUUID(),
    key = `inputs/${assetId}/source`,
    expiresAt = new Date(Date.now() + 3600000),
    input = resolve('.data/fixtures/audio.m4a');
  await uploadFromFile(key, input);
  const media = await probeEditor(input, new AbortController().signal);
  const segments = Array.from({ length: 105 }, (_, i) => ({
    id: `segment-${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 800,
    text: i === 0 ? 'Original text.' : '测试段落 ' + i,
    speakerId: 'a',
  }));
  await db().transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId,
      owner,
      key,
      name: 'transcript-test.m4a',
      size: (await stat(input)).size,
      mime: 'audio/mp4',
      state: 'ready',
      expiresAt,
    });
    await tx.insert(jobs).values({
      id,
      owner,
      requestId: randomUUID(),
      assetId,
      sourceIds: [assetId],
      tool: 'transcription',
      options: { language: 'auto', streamIndex: 0 },
      state: 'completed',
      progress: 100,
      expiresAt,
    });
    await tx.insert(jobInputs).values({ jobId: id, assetId });
    await tx.insert(transcripts).values({
      jobId: id,
      revision: 1,
      data: {
        durationMs: 120000,
        segments,
        speakers: [
          { id: 'a', name: 'Alice', needsReview: false },
          { id: 'b', name: 'Bob', needsReview: false },
        ],
      },
    });
    await tx.insert(preparations).values({
      id: randomUUID(),
      owner,
      assetId,
      profile: 'audio',
      streamIndex: 0,
      state: 'completed',
      media,
      previewKey: key,
      expiresAt,
    });
  });
  try {
    await page.goto(`/en/workspace/${id}`);
    await expect(page.getByRole('heading', { name: /^Transcript/ })).toBeVisible();
    await expect(page.locator('.transcript-segment textarea')).toHaveCount(0);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy all', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('测试段落 104');
    await expect(page.locator('.transcript-segment')).toHaveCount(100);
    await page.getByRole('button', { name: 'Edit segment 1', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Segment text 1', exact: true })
      .fill('已修改的文字。Edited text.');
    await expect(page.locator('.transcript-file-status').getByRole('status')).toContainText(
      'Saved',
    );
    await page.getByRole('button', { name: 'Load more segments' }).click();
    await expect(page.locator('.transcript-segment')).toHaveCount(105);
    const other = await context.newPage();
    await other.goto(`/en/workspace/${id}`);
    await other.getByRole('button', { name: 'Edit segment 1', exact: true }).click();
    await expect(other.getByRole('textbox', { name: 'Segment text 1', exact: true })).toHaveValue(
      '已修改的文字。Edited text.',
    );
    await page
      .getByRole('textbox', { name: 'Segment text 1', exact: true })
      .fill('最终文本。Final text.');
    await expect(page.locator('.transcript-file-status').getByRole('status')).toContainText(
      'Saved',
    );
    await other
      .getByRole('textbox', { name: 'Segment text 1', exact: true })
      .fill('Stale tab edit');
    await expect(other.getByRole('alert').filter({ hasText: 'another tab' })).toBeVisible();
    await other.close();
    const first = page.locator('.transcript-segment').first();
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 0.4;
    });
    await first
      .locator('textarea')
      .evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(5, 5));
    await first.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.locator('.transcript-segment')).toHaveCount(106);
    await first.getByRole('button', { name: 'Merge next', exact: true }).click();
    await expect(page.locator('.transcript-segment')).toHaveCount(105);
    await page.getByLabel('More actions', { exact: true }).click();
    await page.getByRole('button', { name: 'Manage speakers' }).click();
    await page.locator('#speaker-a').fill('张三 Alice');
    const renamed = page.waitForResponse(
      (r) => r.url().endsWith(`/jobs/${id}/transcript`) && r.request().method() === 'PATCH',
    );
    await page.locator('#speaker-a').press('Tab');
    expect((await renamed).status()).toBe(200);
    await expect(page.locator('#speaker-a')).toHaveValue('张三 Alice');
    await page.getByRole('button', { name: 'Close speakers' }).click();
    const segmentSpeaker = page.getByRole('combobox', { name: 'Segment speaker 1', exact: true });
    for (const name of ['Unknown speaker', 'Bob']) {
      const saved = page.waitForResponse(
        (r) => r.url().endsWith(`/jobs/${id}/transcript`) && r.request().method() === 'PATCH',
      );
      await segmentSpeaker.click();
      await page.getByRole('option', { name, exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expect(segmentSpeaker).toHaveText(name);
    }
    await page.getByLabel('More actions', { exact: true }).click();
    await page.getByRole('button', { name: 'Manage speakers' }).click();
    const merge = page.getByRole('combobox', { name: 'Merge speaker Bob', exact: true });
    await merge.click();
    await expect(
      page.getByRole('dialog', { name: 'Speakers', exact: true }).getByRole('listbox'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Speakers', exact: true })).toBeVisible();
    await expect(merge).toBeFocused();
    const merged = page.waitForResponse(
      (r) => r.url().endsWith(`/jobs/${id}/transcript`) && r.request().method() === 'PATCH',
    );
    await merge.click();
    await page.getByRole('option', { name: '张三 Alice', exact: true }).click();
    expect((await merged).status()).toBe(200);
    await expect(page.locator('#speaker-b')).toHaveCount(0);
    await expect(
      page.getByRole('combobox', { name: 'Merge speaker 张三 Alice', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Close speakers' }).click();
    await expect(segmentSpeaker).toHaveText('张三 Alice');
    await page.getByRole('button', { name: 'Export transcript', exact: true }).click();
    const exportFormat = page.getByRole('combobox', { name: 'Export format', exact: true });
    await exportFormat.click();
    await expect(
      page.getByRole('dialog', { name: 'Export transcript' }).getByRole('listbox'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Export transcript' })).toBeVisible();
    await expect(exportFormat).toBeFocused();
    for (const format of ['txt', 'docx', 'pdf', 'srt', 'vtt']) {
      await page.getByLabel('Export format', { exact: true }).click();
      await page.getByRole('option', { name: format.toUpperCase(), exact: true }).click();
      await page.getByRole('button', { name: 'Create export' }).click();
      const row = page
        .locator('.transcript-exports > div')
        .filter({ has: page.getByText(new RegExp(`^${format.toUpperCase()} · v`)) });
      await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeVisible({
        timeout: 45000,
      });
      const event = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Download', exact: true }).click();
      const download = await event;
      expect(await download.failure()).toBeNull();
      await download.saveAs(resolve(`.data/transcript-browser.${format}`));
    }
    await page.getByRole('button', { name: 'Close export' }).click();
    await page.screenshot({ path: '.data/transcript-editor-accepted.png', fullPage: false });
    await page.reload();
    await expect(page.locator('.transcript-segment')).toHaveCount(100);
    await page.getByRole('button', { name: 'Edit segment 1', exact: true }).click();
    const movedText = await page
      .getByRole('textbox', { name: 'Segment text 1', exact: true })
      .inputValue();
    await page.getByRole('spinbutton', { name: 'End 1', exact: true }).fill('109.8');
    await page.getByRole('spinbutton', { name: 'Start 1', exact: true }).fill('109');
    await expect(page.locator('.transcript-file-status').getByRole('status')).toContainText(
      'Saved',
    );
    await page.getByRole('button', { name: 'Load more segments' }).click();
    await expect(page.locator('.transcript-segment')).toHaveCount(105);
    const ids = await page
      .locator('.transcript-segment')
      .evaluateAll((elements) => elements.map((e) => e.id));
    expect(new Set(ids).size).toBe(105);
    await expect(page.locator('.transcript-segment textarea').last()).toHaveValue(movedText);
    await page.getByRole('button', { name: 'Done editing' }).click();
    await page.getByLabel('Playback speed', { exact: true }).click();
    await page.getByRole('option', { name: '1.5×', exact: true }).click();
    expect(await page.locator('audio').evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1.5);
    await page.getByRole('switch', { name: 'Auto scroll' }).uncheck();
    await expect(page.getByRole('switch', { name: 'Auto scroll' })).not.toBeChecked();
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 1.2;
    });
    const refreshedAudio = page.waitForResponse((r) =>
      r.url().includes(`/assets/${assetId}/prepare?`),
    );
    await page.clock.fastForward(12 * 60 * 1000);
    await refreshedAudio;
    await expect
      .poll(() =>
        page
          .locator('audio')
          .evaluate(
            (audio: HTMLAudioElement) =>
              audio.readyState > 0 && Math.abs(audio.currentTime - 1.2) < 0.1,
          ),
      )
      .toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.data/transcript-redesign/mobile-editor.png' });
    await page.getByRole('button', { name: 'AI notes', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Summary', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.locator('.transcript-main')).toBeVisible();
    const stranger = await page.request.get(`/api/jobs/${randomUUID()}/transcript`);
    expect(stranger.status()).toBe(404);
  } finally {
    await db()
      .update(preparations)
      .set({ expiresAt: new Date(0) })
      .where(eq(preparations.assetId, assetId));
    await page.request.delete(`/api/jobs/${id}`, { headers: { Origin: 'http://127.0.0.1:3000' } });
  }
});
