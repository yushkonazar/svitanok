import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../web/worker.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;

beforeEach(() => {
  kv = new Map([
    [
      'latest',
      JSON.stringify({
        blocks: [
          { id: 'news', title: 'private title', url: 'https://private.example' },
          { id: 'weather', summary: 'private location' },
          { id: 'invented', text: 'must not persist' },
        ],
      }),
    ],
    ['briefing:2026-09-25', JSON.stringify({ blocks: [{ id: 'mail' }] })],
  ]);
});

afterEach(() => vi.useRealTimers());

function env() {
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  });
}

async function getBriefing(path: string) {
  const initData = await buildInitData(OWNER, BOT_TOKEN);
  const background: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request(`https://svitanok.example${path}`, {
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    env(),
    { waitUntil: (promise: Promise<unknown>) => background.push(promise) },
  );
  await Promise.all(background);
  return response;
}

describe('GET /briefing.json — engagement telemetry', () => {
  it('records only the owner’s current briefing open and allowlisted block ids', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T08:00:00.000Z'));

    const response = await getBriefing('/briefing.json');
    expect(response.status).toBe(200);
    const engagement = JSON.parse(kv.get('stats') ?? '{}').briefingEngagement;
    const day = engagement.days['2026-09-26'];
    expect(day).toMatchObject({ opened: true });
    expect(day.blocks).toEqual({
      news: { exposed: 1, action: 0, save: 0, dismiss: 0 },
      weather: { exposed: 1, action: 0, save: 0, dismiss: 0 },
    });
    expect(JSON.stringify(engagement)).not.toContain('private');
  });

  it('does not count an archived briefing as a fresh daily exposure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T08:00:00.000Z'));

    const response = await getBriefing('/briefing.json?date=2026-09-25');
    expect(response.status).toBe(200);
    expect(kv.has('stats')).toBe(false);
  });
});
