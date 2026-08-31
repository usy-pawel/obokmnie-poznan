import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/e2e',
  timeout: 15_000,
  expect: { timeout: 4_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['line']],
  use: {
    browserName: 'chromium',
    locale: 'pl-PL',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { viewport: { width: 1366, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    wait: { stdout: /obokmnie listening on 127\.0\.0\.1:(?<RADAR_E2E_PORT>\d+)/ },
    reuseExistingServer: false,
    timeout: 10_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
