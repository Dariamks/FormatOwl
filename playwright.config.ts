import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1365, height: 900 },
  },
  expect: { timeout: 15000 },
});
