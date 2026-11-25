import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
