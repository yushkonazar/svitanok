import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Явні імпорти з 'vitest' (без globals) — щоб не розширювати tsconfig types
    globals: false,
  },
});
