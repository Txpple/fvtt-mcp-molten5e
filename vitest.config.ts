import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The live integration suite has its own config (vitest.integration.config.ts).
    // Keep the default `npm test` fast and fully offline by excluding it here.
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
  },
});
