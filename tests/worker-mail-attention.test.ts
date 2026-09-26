import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../web/worker.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';
const NOW = Date.now();

let kv: Map<string, string>;

beforeEach(() => {
  kv = new Map([
    [
      'state',
      JSON.stringify({
        mailTriage: {
          lastRunMs: NOW,
          candidates: [
            {
              id: 'mail-1',
              from: 'hr@example.com',
              subject: 'Interview tomorrow',
              snippet: 'PRIVATE MESSAGE BODY',
              atMs: NOW - 1_000,
              attention: { level: 'critical', reasons: ['interview_or_deadline'] },
            },
          ],
        },
      }),
    ],
  ]);
});

function env() {
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  });
}

async function readAttention(userId = OWNER) {
  const initData = await buildInitData(userId, BOT_TOKEN);
  return worker.fetch(
    new Request('https://svitanok.example/api/mail/attention', {
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    env(),
    { waitUntil: () => undefined },
  );
}

describe('GET /api/mail/attention', () => {
  it('is owner-only and returns tainted read-only metadata with a Gmail citation', async () => {
    const response = await readAttention();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      tainted: boolean;
      mode: string;
      summary: unknown;
      items: unknown[];
    };
    expect(body).toMatchObject({
      ok: true,
      tainted: true,
      mode: 'read_only',
      summary: { total: 1, critical: 1, attention: 0 },
    });
    expect(body.items).toEqual([
      {
        id: 'mail-1',
        from: 'hr@example.com',
        subject: 'Interview tomorrow',
        atMs: NOW - 1_000,
        level: 'critical',
        reasons: ['interview_or_deadline'],
        citation: {
          source: 'gmail_message',
          messageId: 'mail-1',
          url: 'https://mail.google.com/mail/u/0/#all/mail-1',
        },
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/mail-1',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('PRIVATE MESSAGE BODY');

    const stranger = await readAttention(9999);
    expect(stranger.status).toBe(403);
  });
});
