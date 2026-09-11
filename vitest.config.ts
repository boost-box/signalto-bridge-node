import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Real HTTP servers on ephemeral ports — generous but bounded.
    testTimeout: 20_000,
  },
});
