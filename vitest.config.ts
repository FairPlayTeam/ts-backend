import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.ts'],
    sequence: { concurrent: false },
    hookTimeout: 120_000,
    testTimeout: 45_000,
  },
});
