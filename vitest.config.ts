import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      /* `cloudflare:workers` — вбудований модуль workerd (базовий клас
         DurableObject). У Node його немає, а тести імпортують worker.js
         напряму, тож без підміни падав би САМ ІМПОРТ — і разом із ним усі
         тести, не лише ті, що торкаються DO. Заглушка робить те саме, що
         справжній клас для нашого коду: кладе ctx/env на this. На збірку
         Cloudflare це не впливає — там модуль справжній. */
      'cloudflare:workers': fileURLToPath(
        new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Явні імпорти з 'vitest' (без globals) — щоб не розширювати tsconfig types
    globals: false,
  },
});
