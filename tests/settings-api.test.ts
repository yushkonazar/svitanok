import { settingsResponseSchema } from '../web/app/src/api/settings-schema.ts';
import { expect, it } from 'vitest';
import { handleSettings } from '../web/api-dashboard.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
const TOKEN = 'settings-test-token';
function setup() {
  const store = new Map<string, string>();
  const env = workerEnv({
    BRIEFING: memoryKv(store),
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_OWNER_USER_ID: '1',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    MONO_TOKEN: 'fake-mono',
  });
  return { store, env };
}
it('keeps settings private and exposes honest connector metadata without provider requests', async () => {
  const { env, store } = setup();
  const init = await buildInitData(1, TOKEN);
  const url = 'https://test.invalid/api/settings';
  expect((await handleSettings(new Request(url), env)).status).toBe(401);
  const response = await handleSettings(
    new Request(url, { headers: { 'x-telegram-init-data': init } }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(settingsResponseSchema.parse(await response.json()).connectors).toMatchObject({
    scopeKnown: false,
    calendarWrite: false,
    mono: true,
  });
  store.set(
    'googleToken',
    JSON.stringify({ scope: 'https://www.googleapis.com/auth/calendar.events.readonly' }),
  );
  const second = await handleSettings(
    new Request(url, { headers: { 'x-telegram-init-data': init } }),
    env,
  );
  expect(settingsResponseSchema.parse(await second.json()).connectors).toMatchObject({
    scopeKnown: true,
    calendar: true,
    calendarWrite: false,
    gmail: false,
  });
});
it('round-trips settings including current news and check-in preferences', async () => {
  const { env } = setup();
  const init = await buildInitData(1, TOKEN);
  const settings = {
    quiet: { enabled: true, from: '21:00', to: '09:00' },
    modules: { fact: false },
    mutedTopics: ['Наука'],
    news: { sources: ['BBC'], intervalHours: 6 },
    checkin: {
      version: 3,
      schedule: { morning: '07:00', afternoon: '18:00', evening: '22:00', end: '03:00' },
      modules: [],
      habits: [],
      categories: [],
      hiddenCategories: [],
    },
  };
  const response = await handleSettings(
    new Request('https://test.invalid/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': init },
      body: JSON.stringify({ settings }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(settingsResponseSchema.parse(await response.json()).settings).toMatchObject(settings);
  const read = await handleSettings(
    new Request('https://test.invalid/api/settings', { headers: { 'x-telegram-init-data': init } }),
    env,
  );
  expect(settingsResponseSchema.parse(await read.json()).settings).toMatchObject(settings);
});
