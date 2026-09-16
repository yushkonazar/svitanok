import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const CHUNK_BUDGET_BYTES = 300 * 1024;

/** Бюджет — це build failure, а не рекомендація, яку можна не помітити в CI. */
function enforceChunkBudget(): Plugin {
  return {
    name: 'svitanok-chunk-budget',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || chunk.code.length <= CHUNK_BUDGET_BYTES) continue;
        this.error(
          `${chunk.fileName} важить ${Math.ceil(chunk.code.length / 1024)} KB після minify; ` +
            `ліміт Mini App — ${CHUNK_BUDGET_BYTES / 1024} KB. Винеси екран або залежність у lazy chunk.`,
        );
      }
    },
  };
}

// Білд React-дашборда (роадмеп v3, група E). Виходить у ../public/app, тож Worker
// віддає його статикою (env.ASSETS) за шляхом /app — поруч зі старим index.html
// на /, який лишається недоторканим до фінального перемикання (E4).
//
// base: '/app/' — усі ассети адресуються від /app/ (Mini App відкривається за
// цим підшляхом). emptyOutDir чистить лише ../public/app, НЕ весь ../public
// (там живе прод-index.html).
export default defineConfig({
  plugins: [react(), tailwindcss(), enforceChunkBudget()],
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    // Мобільний вебв'ю Telegram — первинна ціль; сучасні таргети менший бандл.
    target: 'es2022',
    sourcemap: false,
    // Нові екрани мусять лишатись lazy chunks. 300 KB після minify (до gzip)
    // — межа для мобільного WebView, яку дублює enforceChunkBudget() вище.
    chunkSizeWarningLimit: 300,
    rolldownOptions: {
      output: {
        // Спільні runtime-бібліотеки отримують сталі імена для кешування між
        // lazy-маршрутами. Це також не дає оболонці потягнути їх одним blob'ом.
        codeSplitting: {
          groups: [
            {
              name: 'react-runtime',
              test: /node_modules[\\/](?:@remix-run[\\/]|react(?:-dom|-router(?:-dom)?)?|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: 'query-runtime',
              test: /node_modules[\\/]@tanstack[\\/]/,
              priority: 3,
            },
            {
              name: 'validation-runtime',
              test: /node_modules[\\/]zod[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5174,
    // Локальна розробка: /api/* і /briefing.json проксі на wrangler dev (8787),
    // щоб дані вантажились із реального Worker'а. Поза Telegram усе одно SAMPLE.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/briefing.json': 'http://127.0.0.1:8787',
    },
  },
});
