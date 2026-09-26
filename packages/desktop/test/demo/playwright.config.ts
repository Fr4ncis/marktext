import { defineConfig } from '@playwright/test'

// Issue walkthrough recordings, kept out of the e2e suite: they take minutes,
// they mutate a tracked file to stage the pre-fix state, and their output is a
// video rather than a pass/fail signal.
//
//   pnpm -C packages/desktop exec playwright test -c test/demo/playwright.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.demo.ts',
  workers: 1,
  // A recording drives a real app twice over and then encodes; nothing here is
  // waiting on a locator, so the generous budget costs nothing when it passes.
  timeout: 600000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 }
  }
})
