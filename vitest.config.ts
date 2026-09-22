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
    // workerd-only imports (`cloudflare:test`) мають власний runtime і конфіг.
    // Без виключення Node-suite намагається виконати їх під заглушкою й дає
    // хибне падіння всього регресу.
    exclude: ['tests/workers/**'],
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
      include: [
        'src/**/*.ts',
        'web/*.mjs',
        'web/core/**/*.mjs',
        'web/worker.js',
        'host/*.mjs',
        'brain/src/**/*.ts',
      ],
      // brain: index.ts і sdk/ — wiring без власної логіки (node:http-обвʼязка
      // та єдине місце імпорту Agent SDK); їх перевіряють tsc -p brain проти
      // справжніх d.ts, збірка в CI і смоук деплою (health-greп по sha) — у
      // node-тестах їм нема чого міряти, а нулі лише зсували б пороги.
      exclude: ['**/*.d.ts', '**/*.d.mts', 'brain/src/index.ts', 'brain/src/sdk/**'],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
