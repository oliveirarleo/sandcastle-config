import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '.sandcastle/**/*.test.mts'],
  },
  resolve: {
    // NodeNext module resolution is configured in tsconfig.json;
    // vitest picks it up automatically.
  },
});
