/// <reference types="@cloudflare/vitest-plugin/types" />

// Контракти зовнішніх меж у справжньому workerd. Усі HTTP-виклики перехоплені
// локальним fake fetch: suite перевіряє роутинг, auth, D1/DO й waitUntil, але
// фізично не може торкнутися Telegram, Google чи Monobank.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as runtimeEnv } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { writeMonoAccounts } from '../../web/core/finance/store.mjs';
import { googleAccessToken } from '../../web/google.mjs';
import worker from '../../web/worker.js';

type RuntimeEnv = Env & {
  DB: D1Database;
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};

const env = runtimeEnv as RuntimeEnv;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

function fakeExternalFetch() {
  const calls: Array<{ url: string; body: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body == null ? null : String(init.body) });
      if (url.startsWith('https://api.telegram.org/')) {
        return Response.json({ ok: true, result: { message_id: 9001 } });
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'workers-test-access-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events',
        });
      }
      throw new Error(`Зовнішній HTTP-виклик поза fake-контрактом: ${url}`);
    }),
  );
  return calls;
}

describe('ізольовані контракти зовнішніх інтеграцій', () => {
  it('приймає Telegram webhook, виконує фонову команду та шле відповідь через fake API', async () => {
    const calls = fakeExternalFetch();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://svitanok.test/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET!,
        },
        body: JSON.stringify({
          update_id: 1001,
          message: {
            message_id: 101,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Тест' },
            text: '/reminders',
          },
        }),
      }),
      env,
      ctx,
    );

    expect(await response.json()).toEqual({ ok: true });
    await waitOnExecutionContext(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/sendMessage');
    expect(JSON.parse(calls[0]!.body ?? '{}')).toMatchObject({ chat_id: 42 });
  });

  it('приймає дозволену Mono транзакцію через production route та зберігає її в D1', async () => {
    const calls = fakeExternalFetch();
    const nowMs = Date.now();
    await writeMonoAccounts(
      env,
      [{ id: 'workers-account', currency: 'UAH', maskedPan: '44**11' }],
      nowMs,
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://svitanok.test/api/mono/${env.MONO_WEBHOOK_SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'StatementItem',
          data: {
            account: 'workers-account',
            statementItem: {
              id: 'workers-tx-1',
              time: Math.floor(nowMs / 1000),
              description: 'Workers test merchant',
              mcc: 5732,
              amount: -134_000,
              operationAmount: -134_000,
              currencyCode: 980,
              hold: false,
              balance: 1_000_000,
            },
          },
        }),
      }),
      env,
      ctx,
    );

    expect(await response.json()).toEqual({ ok: true });
    await waitOnExecutionContext(ctx);
    const tx = await env.DB.prepare('SELECT id, description FROM transactions WHERE id = ?')
      .bind('workers-tx-1')
      .first<{ id: string; description: string }>();
    expect(tx).toEqual({ id: 'workers-tx-1', description: 'Workers test merchant' });
    expect(calls.some((call) => call.url.includes('/sendMessage'))).toBe(true);
  });

  it('не виконує Telegram update повторно після успішної фонової доставки', async () => {
    const calls = fakeExternalFetch();
    const makeRequest = () =>
      new Request('https://svitanok.test/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET!,
        },
        body: JSON.stringify({
          update_id: 1002,
          message: {
            message_id: 102,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Тест' },
            text: '/reminders',
          },
        }),
      });

    const firstCtx = createExecutionContext();
    expect(await (await worker.fetch(makeRequest(), env, firstCtx)).json()).toEqual({ ok: true });
    await waitOnExecutionContext(firstCtx);

    const duplicateCtx = createExecutionContext();
    expect(await (await worker.fetch(makeRequest(), env, duplicateCtx)).json()).toEqual({
      ok: true,
    });
    await waitOnExecutionContext(duplicateCtx);
    expect(calls).toHaveLength(1);
  });

  it('отримує та кешує Google OAuth token лише через fake HTTP boundary', async () => {
    const calls = fakeExternalFetch();

    expect(await googleAccessToken(env)).toBe('workers-test-access-token');
    expect(await googleAccessToken(env)).toBe('workers-test-access-token');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.body).toContain('grant_type=refresh_token');

    const cached = JSON.parse((await env.BRIEFING.get('googleToken')) ?? '{}');
    expect(cached).toMatchObject({ token: 'workers-test-access-token' });
  });

  it('деградує чесно при timeout Google OAuth, не записуючи фальшивий token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('simulated timeout');
      }),
    );

    expect(await googleAccessToken(env)).toBeNull();
    expect(await env.BRIEFING.get('googleToken')).toBeNull();
  });
});
