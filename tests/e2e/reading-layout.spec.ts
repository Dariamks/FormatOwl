import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.data/translation-live');
const state = resolve(root, 'browser-state.json');
const records: { id: string; tool: string }[] = existsSync(resolve(root, 'end-to-end.json'))
  ? JSON.parse(readFileSync(resolve(root, 'end-to-end.json'), 'utf8'))
  : [];
test.use({ storageState: existsSync(state) ? state : undefined });
const record = records.find((r) => r.tool === 'document-translator');
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});
async function setup(page: Page) {
  test.skip(!record, 'Requires translation fixtures');
  const id = record!.id;
  const reading = await (await page.request.get(`/api/jobs/${id}/reading`)).json();
  const view = await (await page.request.get(`/api/jobs/${id}/translation`)).json();
  const block = view.data.blocks.find((b: any) => b.sourceText.trim());
  const citation = { blockId: block.id, quote: block.sourceText.slice(0, 30) };
  const options = {
    revision: view.revision,
    language: 'zh',
    detail: 'brief',
    template: 'notes',
    page: 0,
    question: '',
    resultVersion: 2,
  };
  const rich = {
    version: 2,
    title: '文件阅读笔记',
    insufficient: false,
    nodes: [],
    sections: [
      {
        heading: '重点比较',
        text: '',
        citations: [],
        blocks: [
          { type: 'paragraph', text: '保留原文与译文的对照关系。', citations: [citation] },
          { type: 'list', items: [{ text: '列表中的说明', citations: [citation] }] },
          {
            type: 'table',
            columns: ['项目', '内容'],
            rows: [{ cells: ['文件', '可搜索的长文字说明'], citations: [citation] }],
          },
        ],
      },
    ],
  };
  const base = {
    revision: view.revision,
    contentHash: reading.contentHash,
    state: 'completed',
    error: null,
    formats: ['md'],
    completedUnits: 1,
    totalUnits: 1,
    waitingUntil: null,
    createdAt: '2026-09-16T00:00:00Z',
  };
  const rows: any[] = [
    {
      ...base,
      id: 'summary-fixture',
      kind: 'summary',
      options: { ...options, kind: 'summary' },
      result: rich,
    },
    {
      ...base,
      id: 'map-fixture',
      kind: 'mindmap',
      formats: ['md', 'png', 'svg'],
      options: { ...options, kind: 'mindmap' },
      result: {
        title: '文件主题',
        insufficient: false,
        sections: [],
        nodes: [
          { id: 'root', parentId: null, label: '主题', citations: [citation] },
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `n${i}`,
            parentId: 'root',
            label: `关键内容 ${i + 1}`,
            citations: [citation],
          })),
        ],
      },
    },
  ];
  const submissions: any[] = [];
  await page.route(`**/api/jobs/${id}/reading`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      if (body.kind === 'preview') return route.continue();
      submissions.push(body);
      const activity = {
        ...base,
        id: `analysis-${submissions.length}`,
        kind: body.kind,
        options: { ...options, ...body },
        state: 'queued',
        result: null,
        createdAt: new Date().toISOString(),
      };
      if (body.kind === 'chat')
        activity.options.turnId = body.regenerateOf
          ? rows.find((a) => a.id === body.regenerateOf)?.options.turnId
          : activity.id;
      rows.unshift(activity);
      return route.fulfill({ json: activity });
    }
    const response = await route.fetch();
    const json = await response.json();
    return route.fulfill({
      json: {
        ...json,
        activities: [...rows, ...json.activities.filter((a: any) => a.kind === 'preview')],
      },
    });
  });
  await page.goto(`/zh/workspace/${id}`);
  await expect(page.getByRole('heading', { name: '文件阅读笔记' })).toBeVisible();
  return { rows, submissions, rich };
}

test('equal columns, independent reader modes, correction return and responsive surfaces', async ({
  page,
}) => {
  await setup(page);
  const panel = page.getByRole('complementary', { name: 'AI 阅读', exact: true });
  const left = page.locator('.reader-file-column');
  for (const width of [1440, 1920, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () =>
        Math.abs((await left.boundingBox())!.width - (await panel.boundingBox())!.width),
      )
      .toBeLessThan(2);
    const a = await left.locator('.reader-column-toolbar').boundingBox();
    const b = await panel.locator('.reader-column-toolbar').boundingBox();
    expect(a!.y).toBe(b!.y);
    expect(a!.height).toBe(b!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.getByRole('button', { name: '双语对照', exact: true }).click();
  await expect(page.locator('.translation-reading-columns.two').first()).toBeVisible();
  await page.getByRole('button', { name: '校正此段' }).first().click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('complementary', { name: '校正面板' })).toBeVisible();
  await page.getByRole('button', { name: '关闭校正' }).click();
  await expect(panel.getByRole('tab', { name: '摘要' })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: '关闭 AI 阅读' }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'AI 阅读', exact: true }).click();
  await expect(panel).toBeVisible();
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(left).toBeVisible();
    await page.getByRole('tab', { name: 'AI 阅读', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(left).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(root, 'reading', `split-summary-${width}.png`) });
  }
});

test('map fits, pans and retains manual zoom across polling and tab changes', async ({ page }) => {
  const { submissions } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const panel = page.locator('.reading-panel');
  await panel.getByRole('tab', { name: '思维导图' }).click();
  const map = panel.locator('.reading-map-scroll');
  await expect(map).toBeVisible();
  expect((await map.boundingBox())!.height).toBeGreaterThan(600);
  const bounds = await map.boundingBox();
  const nodes = await panel.locator('[data-map-transform]').boundingBox();
  expect(nodes!.x).toBeGreaterThanOrEqual(bounds!.x);
  expect(nodes!.x + nodes!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  await panel.getByRole('button', { name: '放大导图' }).click();
  const transform = await panel.locator('[data-map-transform]').getAttribute('transform');
  await page.waitForResponse(
    (response) => response.url().endsWith('/reading') && response.request().method() === 'GET',
  );
  await expect(panel.locator('[data-map-transform]')).toHaveAttribute('transform', transform!);
  await panel.getByRole('tab', { name: '摘要' }).click();
  await panel.getByRole('tab', { name: '思维导图' }).click();
  await expect(panel.locator('[data-map-transform]')).toHaveAttribute('transform', transform!);
  await page.mouse.move(bounds!.x + 20, bounds!.y + bounds!.height - 20);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 100, bounds!.y + bounds!.height - 40);
  await page.mouse.up();
  expect(await panel.locator('[data-map-transform]').getAttribute('transform')).not.toBe(transform);
  await panel.getByRole('button', { name: '适应画布' }).click();
  await page.screenshot({ path: resolve(root, 'reading', 'split-map-1440.png') });
  expect(submissions).toHaveLength(0);
});

test('regeneration keeps old rich content, template caches are separate, chat keeps one question', async ({
  page,
}) => {
  const { rows, submissions, rich } = await setup(page);
  const panel = page.locator('.reading-panel');
  await expect(panel.locator('table')).toBeVisible();
  await expect(panel.locator('li')).toContainText('列表中的说明');
  await panel.getByRole('button', { name: '重新生成', exact: true }).dblclick();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].regenerate).toBe(true);
  expect(submissions[0].requestId).toBeTruthy();
  await expect(panel.getByRole('heading', { name: '文件阅读笔记' })).toBeVisible();
  rows[0].state = 'failed';
  rows[0].error = 'AI_REQUEST_FAILED';
  await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(panel.locator('table')).toBeVisible();
  await expect(panel.getByRole('button', { name: '复制分析' })).toBeEnabled();
  await panel.getByRole('combobox', { name: '摘要模板' }).click();
  await page.getByRole('option', { name: '重点提要', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].template).toBe('takeaways');
  rows[0].state = 'completed';
  rows[0].result = rich;
  await expect(panel.locator('table')).toBeVisible();
  await panel.getByRole('combobox', { name: '摘要模板' }).click();
  await page.getByRole('option', { name: 'AI 笔记', exact: true }).click();
  expect(submissions).toHaveLength(2);
  await panel.getByRole('tab', { name: '问答' }).click();
  await panel.getByRole('textbox', { name: '向文件提问' }).fill('这个文件有什么用途？');
  await panel.getByRole('button', { name: '发送问题' }).click();
  await expect.poll(() => submissions.length).toBe(3);
  rows[0].state = 'completed';
  rows[0].result = rich;
  await expect(panel.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(4);
  expect(submissions[3].regenerateOf).toBe(rows[1].id);
  await expect(panel.locator('.reading-question')).toHaveCount(1);
  await expect(panel.locator('.reading-chat-body table')).toBeVisible();
});

test('language is independent, invalid regeneration is rejected, and reader position survives switching', async ({
  page,
}) => {
  const { rows, submissions, rich } = await setup(page);
  const invalid = await page.request.post(`/api/jobs/${record!.id}/reading`, {
    headers: { Origin: 'http://127.0.0.1:3000' },
    data: { kind: 'summary', revision: 1, regenerate: true },
  });
  expect(invalid.status()).toBe(400);
  await page.setViewportSize({ width: 1440, height: 640 });
  const panel = page.locator('.reading-panel');
  await panel.locator('summary[aria-label="AI 输出语言"]').click();
  await panel.getByRole('combobox', { name: 'AI 输出语言选项' }).click();
  await page.getByRole('option', { name: '阿拉伯语', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].language).toBe('ar');
  rows[0].state = 'completed';
  rows[0].result = { ...rich, title: 'ملخص الملف' };
  await expect(panel.getByRole('heading', { name: 'ملخص الملف' })).toBeVisible();
  await expect(panel.locator('.reading-tab-content:not([hidden]) article')).toHaveAttribute(
    'dir',
    'rtl',
  );
  await expect(page.locator('.reader-target-language')).toContainText('简体中文');
  await panel.locator('summary[aria-label="AI 输出语言"]').click();
  await page.getByRole('button', { name: '文字', exact: true }).click();
  const reader = page.locator('.translation-reading');
  await reader.evaluate((el) => {
    el.scrollTop = 120;
  });
  await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBe(120);
  await page.getByRole('button', { name: '版式', exact: true }).click();
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBe(120);
});
