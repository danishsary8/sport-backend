import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'dist/**'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
