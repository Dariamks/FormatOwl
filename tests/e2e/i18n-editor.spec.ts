import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Fixed responses exercise the real editor without submitting any AI work.
for (const locale of ['en', 'ar']) {
  test(`${locale}: document direction, reading and save protection are independent of UI locale`, async ({
    page,
  }) => {
    const id = '00000000-0000-4000-8000-000000000026';
    const copy = JSON.parse(await readFile(`apps/web/messages/${locale}/translation.json`, 'utf8'));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /MISSING_MESSAGE|INVALID_MESSAGE/.test(message.text()))
        errors.push(message.text());
    });
    const data = {
      format: 'png',
      sourceLanguage: 'en',
      targetLanguage: 'ar',
      pages: [{ index: 0, width: 400, height: 200, title: '' }],
      blocks: [
        {
          id: 'block-one',
          kind: 'text',
          page: 0,
          sourceText: 'Source text in English',
          translatedText: 'نص عربي',
          box: { x: 10, y: 10, width: 350, height: 80, angle: 0 },
          style: { fontSize: 20, color: '#111111', align: 'right' },
          review: [],
          stale: false,
          keepOriginal: false,
        },
      ],
    };
    let release!: () => void, started!: () => void;
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let revision = 1;
    await page.route(`**/api/jobs/${id}**`, async (route) => {
      const url = new URL(route.request().url()),
        method = route.request().method();
      if (url.pathname.endsWith('/translation') && method === 'PATCH') {
        started();
        await pending;
        data.blocks[0].translatedText = route.request().postDataJSON().upsert[0].translatedText;
        return route.fulfill({ json: { revision: ++revision } });
      }
      if (
        url.pathname.endsWith('/reading') &&
        method === 'POST' &&
        route.request().postDataJSON().kind === 'preview'
      )
        return route.fulfill({
          json: {
            id: 'preview-fixture',
            state: 'completed',
            result: { format: 'png', overflow: [], regions: [] },
          },
        });
      // Any unexpected mutation is blocked here, including automatic AI generation.
      if (method !== 'GET') return route.fulfill({ status: 400, json: { error: 'INVALID_INPUT' } });
      if (url.pathname.endsWith('/translation'))
        return route.fulfill({
          json: { revision, stage: 'ready', completedUnits: 1, totalUnits: 1, data },
        });
      if (url.pathname.endsWith('/exports')) return route.fulfill({ json: { exports: [] } });
      if (url.pathname.endsWith('/media')) return route.fulfill({ json: { url: '/icon.png' } });
      if (url.pathname.endsWith('/reading'))
        return route.fulfill({
          json: {
            contentHash: 'fixture',
            activities: [
              {
                id: 'reading-fixture',
                kind: 'summary',
                state: 'completed',
                revision: 1,
                contentHash: 'fixture',
                options: {
                  kind: 'summary',
                  revision: 1,
                  language: 'en',
                  detail: 'brief',
                  template: 'notes',
                  page: 0,
                  question: '',
                },
                formats: ['md'],
                createdAt: '2026-09-17T00:00:00Z',
                result: {
                  version: 2,
                  title: 'Deterministic reading fixture',
                  insufficient: false,
                  nodes: [],
                  sections: [
                    {
                      heading: 'Notes',
                      text: 'English document content stays left to right.',
                      citations: [],
                    },
                  ],
                },
              },
            ],
          },
        });
      return route.fulfill({
        json: {
          job: {
            id,
            tool: 'image-translator',
            state: 'completed',
            name: 'direction-fixture.png',
            options: { sourceLanguage: 'en', targetLanguage: 'ar' },
            inputSize: 1000,
            progress: 100,
            media: null,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        },
      });
    });
    await page.route('**/api/reading-activities/preview-fixture/download?format=preview', (route) =>
      route.fulfill({ json: { url: '/icon.png' } }),
    );
    try {
      await page.goto(`/${locale}/workspace/${id}`);
      await expect(page.getByText('Deterministic reading fixture', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: copy.edit_5301648, exact: true }).click();
      await expect(page.locator('.translation-canvas').first()).toHaveCSS('direction', 'ltr');
      const translated = page.getByRole('textbox', { name: copy.translation_ac26a7a, exact: true });
      await expect(translated).toHaveAttribute('dir', 'rtl');
      await expect(
        page.getByRole('textbox', { name: copy.source_text_6f377d2, exact: true }),
      ).toHaveAttribute('dir', 'auto');
      await translated.fill('نص عربي معدل');
      await saving;
      await expect(page.locator('.translation-editor .locale-select')).toBeDisabled();
      release();
      await expect(page.locator('.translation-editor .locale-select')).toBeEnabled();
      await expect(translated).toHaveValue('نص عربي معدل');
      expect(data.targetLanguage).toBe('ar');
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.locator('.translation-editor .locale-select')).toBeInViewport();
      await page.screenshot({
        path: `.data/i18n/${locale}-translation-editor.png`,
        fullPage: true,
      });
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
