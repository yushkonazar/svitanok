import { afterEach, expect, it, vi } from 'vitest';
import { handleEvent, handleSettings } from '../web/api-dashboard.mjs';
import { loadSettings, putSettings } from '../web/kv-store.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
const token = 'choices-test-token';
const command = {
  type: 'checkin_choice',
  op: 'create',
  field: 'moodFactorsV4',
  optionId: 'user_12345678',
  label: 'Кава на балконі',
  group: 'Маленькі радощі',
  scope: 'mood:positive',
  requestId: 'request_12345678',
  expectedRevision: 0,
};
function setup() {
  const store = new Map<string, string>();
  const env = workerEnv({
    BRIEFING: memoryKv(store),
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_OWNER_USER_ID: '1',
    TELEGRAM_COOWNER_USER_IDS: '2',
  });
  return { store, env };
}
async function post(env: Env, body: Record<string, unknown>, owner = 1) {
  const auth = owner ? await buildInitData(owner, token) : '';
  return handleEvent(
    new Request('https://test.invalid/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': auth },
      body: JSON.stringify(body),
    }),
    env,
  );
}
afterEach(() => vi.useRealTimers());
it('requires the primary owner for CRUD, including when a co-owner can read', async () => {
  const { env, store } = setup();
  expect((await post(env, command, 0)).status).toBe(401);
  expect((await post(env, command, 2)).status).toBe(403);
  expect(store.has('settings')).toBe(false);
  expect((await post(env, command)).status).toBe(200);
  const init = await buildInitData(2, token);
  const response = await handleSettings(
    new Request('https://test.invalid/api/settings', { headers: { 'x-telegram-init-data': init } }),
    env,
  );
  const data = (await response.json()) as KvBlob;
  expect(data.settings.checkinChoices.entries[0].label).toBe(command.label);
  expect(data.settings.checkinChoices).not.toHaveProperty('receipts');
});
it('persists across reads, retries once logically, and refuses stale concurrent revisions', async () => {
  const { env } = setup();
  const first = await post(env, command);
  expect(first.status).toBe(200);
  const again = await post(env, command);
  expect(again.status).toBe(200);
  expect((await loadSettings(env)).checkinChoices?.revision).toBe(1);
  const conflict = await post(env, {
    ...command,
    optionId: 'user_87654321',
    requestId: 'request_second',
  });
  expect(conflict.status).toBe(409);
  const stale = await post(env, { ...command, label: 'Інший зміст' });
  expect(stale.status).toBe(409);
  const body = (await first.json()) as KvBlob;
  expect(body.choices).not.toHaveProperty('receipts');
});
it('preserves choices through stale general settings saves and ignores forged catalogs', async () => {
  const { env } = setup();
  await post(env, command);
  const saved = await putSettings(env, {
    quiet: { enabled: true },
    modules: { weather: false },
    checkinChoices: { version: 1, revision: 99, entries: [] },
  });
  expect(saved.checkinChoices?.revision).toBe(1);
  expect(saved.checkinChoices?.entries[0]?.label).toBe(command.label);
  const empty = setup();
  expect(
    (await putSettings(empty.env, { checkinChoices: saved.checkinChoices })).checkinChoices,
  ).toBeUndefined();
});
it('uses canonical choices and labels for a confirmation, ignoring client-supplied catalogs and snapshots', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T08:00:00Z'));
  const { env, store } = setup();
  await post(env, command);
  const response = await post(env, {
    type: 'checkin',
    questionVersion: 4,
    optionsRevisionV4: 1,
    slot: 'morning',
    dateKey: '2026-11-04',
    energy: 4,
    mood: 5,
    sleepModeV4: 'none',
    priorityV4: 'rest',
    moodFactorsV4: [command.optionId, 'conflict'],
    confirmed: true,
    checkinChoicesV4: { entries: [] },
    optionLabelsV4: { moodFactorsV4: { [command.optionId]: 'Forged' } },
  });
  expect(response.status).toBe(200);
  const record = JSON.parse(store.get('stats')!).checkins['2026-11-04'].morning;
  expect(record.moodFactorsV4).toEqual([command.optionId]);
  expect(record.optionLabelsV4.moodFactorsV4[command.optionId]).toBe(
    `${command.group} :: ${command.label}`,
  );
  expect(record).not.toHaveProperty('checkinChoicesV4');
});
it('requires review when another device edited answer labels before confirmation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T08:00:00Z'));
  const { env, store } = setup();
  await post(env, command);
  const response = await post(env, {
    type: 'checkin',
    questionVersion: 4,
    optionsRevisionV4: 0,
    slot: 'morning',
    dateKey: '2026-11-04',
    energy: 4,
    mood: 5,
    sleepModeV4: 'none',
    priorityV4: 'rest',
    confirmed: true,
  });
  expect(response.status).toBe(409);
  expect(store.has('stats')).toBe(false);
});
it('rejects attempts to modify scales or exclusive answers', async () => {
  const { env } = setup();
  expect((await post(env, { ...command, field: 'energy', optionId: 'user_12345678' })).status).toBe(
    400,
  );
  expect((await post(env, { ...command, op: 'delete', optionId: 'unknown' })).status).toBe(400);
});
