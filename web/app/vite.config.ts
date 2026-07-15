import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Білд React-дашборда (роадмеп v3, група E). Виходить у ../public/app, тож Worker
// віддає його статикою (env.ASSETS) за шляхом /app — поруч зі старим index.html
// на /, який лишається недоторканим до фінального перемикання (E4).
//
// base: '/app/' — усі ассети адресуються від /app/ (Mini App відкривається за
// цим підшляхом). emptyOutDir чистить лише ../public/app, НЕ весь ../public
// (там живе прод-index.html).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    // Мобільний вебв'ю Telegram — первинна ціль; сучасні таргети менший бандл.
    target: 'es2022',
    sourcemap: false,
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
