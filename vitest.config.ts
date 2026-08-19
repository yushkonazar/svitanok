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
    /**
     * Покриття.
     *
     * ⚠️ Доти його не було ЗОВСІМ — ні інструмента в залежностях, ні прогону в
     * CI. Наслідок дорожчий, ніж «не знаємо відсоток»: покриття неможливо було
     * РЕГРЕСУВАТИ. Будь-яке число про нього (включно з тим, що фігурувало в
     * зовнішньому аудиті з точністю до сотих) не відтворювалось у цьому
     * репозиторії ніким — ні власником, ні рецензентом.
     *
     * Пороги виставлені трохи НИЖЧЕ заміряного: гейт має ловити провал, а не
     * падати на природному коливанні в пів відсотка. Піднімати — свідомо, коли
     * реальне покриття підросте.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Міряємо ТЕ, ЩО деплоїться: src/ (оркестратор), web/*.mjs (Worker),
      // host/ (реле). web/app має власний раннер і власні числа.
      include: ['src/**/*.ts', 'web/*.mjs', 'web/worker.js', 'host/*.mjs'],
      exclude: ['**/*.d.ts', '**/*.d.mts'],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
