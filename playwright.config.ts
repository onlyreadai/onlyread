import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // The plain development build, for the fixture's mock service (e2e/global-setup.ts).
  globalSetup: './e2e/global-setup.ts',
  // Live suites (e2e/live-*.spec.ts) call services we do not run, with paid calls: only `npm run e2e:live` runs them.
  testIgnore: process.env.ONLYREAD_LIVE ? [] : ['**/live-*.spec.ts'],
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
