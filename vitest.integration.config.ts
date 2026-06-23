import { defineConfig } from 'vitest/config';

// LIVE integration suite — drives a real headless Chromium against the Molten world.
// Off by default: run with `npm run test:integration` (which builds dist/ first) and
// RUN_LIVE=1 plus a populated .env. Without RUN_LIVE every suite skips (see setup.ts),
// so this config is safe to run offline — it just reports skipped suites.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.int.test.ts'],
    globals: true,
    environment: 'node',
    // A cold Molten box can take minutes to wake + join; connect runs in beforeAll.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    // One headless browser at a time: never open multiple Foundry contexts concurrently.
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
  },
});
