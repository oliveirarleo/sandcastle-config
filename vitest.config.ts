import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // NodeNext module resolution is inherited from tsconfig.json;
    // vitest picks it up automatically.
    include: ['src/**/*.test.ts', '.sandcastle/**/*.test.mts'],
  },
});
