import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['./tests/integration/globalSetup.ts'],
    include: ['tests/integration/**/*.integration.ts'],
    isolate: false,
    sequence: { concurrent: false },
    hookTimeout: 120_000,
    testTimeout: 45_000,
  },
});
