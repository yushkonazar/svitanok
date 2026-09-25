// Реальні інтеграційні тести Worker-а: запускаються у workerd через
// Miniflare, окремо від швидких Node unit-тестів у vitest.config.ts.
// Конфіг читає той самий wrangler.jsonc, що й production, тому binding-и та
// Durable Objects не можуть непомітно розійтися з кодом, який деплоїться.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Плагін 1.1 вмикає remote binding proxy за замовчуванням. Для цього
      // suite це було б небезпечно: тест не має ані читати, ані писати прод.
      remoteBindings: false,
      wrangler: { configPath: './web/wrangler.jsonc' },
      miniflare: {
        // Міграції застосовує setup тесту до ізольованої D1, ніколи до remote.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(join(root, 'web', 'core', 'migrations')),
          // Тестові значення потрібні лише для проходження автентифікованих
          // маршрутів. Це не секрети production і вони існують виключно в
          // ізольованому workerd-процесі Miniflare.
          TELEGRAM_WEBHOOK_SECRET: 'workers-test-webhook-secret',
          TELEGRAM_BOT_TOKEN: 'workers-test-bot-token',
          TELEGRAM_OWNER_USER_ID: '42',
          TELEGRAM_CHAT_ID: '42',
          TOPIC_ASSISTANT: '7',
          TOPIC_SYSTEM: '8',
          MONO_WEBHOOK_SECRET: 'workers-test-mono-secret',
          GOOGLE_CLIENT_ID: 'workers-test-google-client',
          GOOGLE_CLIENT_SECRET: 'workers-test-google-secret',
          GOOGLE_REFRESH_TOKEN: 'workers-test-google-refresh',
        },
      },
    })),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
    globals: false,
  },
});
