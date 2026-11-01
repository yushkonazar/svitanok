import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { weeklyPacketQuality } from '../web/core/brain/weekly-report-quality.mjs';
import { drainOutbox } from '../web/core/tg/outbox.mjs';
import { readWeeklyReports } from '../web/api-weekly-reports.mjs';
import { weeklyReportsSchema } from '../web/app/src/api/weekly-report-schema.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';
import { conciseFixture } from './helpers/weekly-fixture.js';

const NOW = Date.parse('2026-10-26T06:00:00Z');
const migrations = readdirSync(join(__dirname, '../web/core/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const d1 = d1FromSqlite(migrations);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const drafts = new Map<string, number>();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 50 } });
  });
  vi.stubGlobal('fetch', fetch);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    ASSISTANT_V2: 'on',
    INTERNAL_HMAC_KEY: 'synthetic-key',
    TELEGRAM_CHAT_ID: '100',
    TELEGRAM_BOT_TOKEN: 'synthetic-token',
    TELEGRAM_BOT_USERNAME: 'synthetic_bot',
    RUN_REGISTRY: {
      getByName: () => ({
        has: async () => true,
        consumeNonce: async () => true,
        runInfo: async (id: string) => ({
          chatId: 100,
          threadId: 'dm',
          statusMessageId: drafts.get(id) ?? null,
        }),
      }),
    },
  });
  function seed(id: string, fixture = conciseFixture(), at = NOW) {
    d1.db
      .prepare(
        `INSERT INTO runs(id,trigger,profile,started_at,weekly_context_json) VALUES(?,'chat','weekly-review',?,?)`,
      )
      .run(id, new Date(at).toISOString(), JSON.stringify(weeklyPacketQuality(fixture)));
  }
  async function deliver(
    id: string,
    options: { amount?: number; at?: number; failed?: boolean } = {},
  ) {
    const text = options.failed
      ? '⚠️ Provider failed PRIVATE'
      : JSON.stringify({
          highlights: [
            { kind: 'finance', text: `Обліковані витрати — ${options.amount ?? 100} грн.` },
          ],
          actions: [],
        });
    const rawBody = JSON.stringify({ text, ...(options.failed ? { failed: true } : {}) }),
      timestampMs = options.at ?? NOW;
    const nonce = crypto.randomUUID();
    const signature = await signInternal('synthetic-key', {
      method: 'POST',
      path: '/internal/deliver',
      timestampMs,
      runId: id,
      nonce,
      rawBody,
    });
    return handleInternal(
      new Request('https://test/internal/deliver', {
        method: 'POST',
        body: rawBody,
        headers: {
          'X-Internal-Timestamp': String(timestampMs),
          'X-Internal-Run': id,
          'X-Internal-Nonce': nonce,
          'X-Internal-Signature': signature,
        },
      }),
      env,
      timestampMs,
    );
  }
  return { d1, env, fetch, sent, drafts, seed, deliver };
}
describe('single weekly overview across generation, retry and Telegram outbox', () => {
  it('updates a value that returned to an earlier historical state instead of suppressing the correction', async () => {
    const s = setup();
    s.seed('first');
    await s.deliver('first');
    const changed = conciseFixture();
    changed.finance.summary.expenseMinor = 12500;
    s.seed('second', changed, NOW + 1000);
    await s.deliver('second', { amount: 125, at: NOW + 1000 });
    s.seed('third', conciseFixture(), NOW + 2000);
    await s.deliver('third', { amount: 100, at: NOW + 2000 });
    expect(s.sent.map((row) => row.method)).toEqual([
      'sendMessage',
      'editMessageText',
      'editMessageText',
    ]);
    expect(s.sent.at(-1)?.body.text).toContain('100 грн');
  });

  it('keeps the pending active card deliverable after many unchanged suppressed generations', async () => {
    const s = setup();
    s.seed('first');
    s.fetch.mockResolvedValueOnce(
      Response.json({ ok: false, parameters: { retry_after: 60 } }, { status: 429 }),
    );
    await s.deliver('first');
    for (let i = 1; i <= 21; i++) {
      const id = `same-${i}`;
      s.seed(id, conciseFixture(), NOW + i * 1000);
      await s.deliver(id, { at: NOW + i * 1000 });
    }
    await drainOutbox(s.env, { nowMs: NOW + 120000 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.body.text).toContain('100 грн');
  });

  it('does not let malformed historical metadata block delivery or rewrite that old row', async () => {
    const s = setup();
    s.d1.db
      .prepare(
        `INSERT INTO reports(id,kind,period_from,period_to,text_md,status,created_at,quality_json)
      VALUES('old','weekly','2026-10-19','2026-10-25','old','failed','2026-10-26T05:00:00Z','{broken')`,
      )
      .run();
    s.seed('first');
    expect((await s.deliver('first')).status).toBe(200);
    expect(s.sent).toHaveLength(1);
    expect(
      s.d1.db.prepare("SELECT quality_json FROM reports WHERE id='old'").get()?.quality_json,
    ).toBe('{broken');
  });
  it('never streams a partial model decision document into the Telegram status card', async () => {
    const s = setup();
    s.seed('first');
    const rawBody = JSON.stringify({ message_id: 77, text: '{"highlights":[' });
    const nonce = crypto.randomUUID();
    const signature = await signInternal('synthetic-key', {
      method: 'POST',
      path: '/internal/status',
      timestampMs: NOW,
      runId: 'first',
      nonce,
      rawBody,
    });
    const response = await handleInternal(
      new Request('https://test/internal/status', {
        method: 'POST',
        body: rawBody,
        headers: {
          'X-Internal-Timestamp': String(NOW),
          'X-Internal-Run': 'first',
          'X-Internal-Nonce': nonce,
          'X-Internal-Signature': signature,
        },
      }),
      s.env,
      NOW,
    );
    expect(await response.json()).toMatchObject({
      queued: 0,
      suppressed: 'weekly-decision-document',
    });
    expect(s.sent).toHaveLength(0);
  });
  it('renders one short message with the saved-week link and schema-valid private details', async () => {
    const s = setup();
    s.seed('first');
    expect((await s.deliver('first')).status).toBe(200);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.method).toBe('sendMessage');
    expect(s.sent[0]?.body.text).toContain('Тиждень 19.10 — 25.10');
    expect(String(s.sent[0]?.body.text).length).toBeLessThan(2200);
    expect(JSON.stringify(s.sent[0])).toContain('startapp=weekly_20261019');
    expect(s.sent[0]?.body).not.toHaveProperty('weekly_report_id');
    const report = await readWeeklyReports(s.env);
    expect(weeklyReportsSchema.safeParse(report).success).toBe(true);
    const saved = s.d1.db.prepare('SELECT quality_json FROM reports').get();
    expect(JSON.parse(String(saved?.quality_json)).delivery.messageId).toBe(50);
  });
  it('does not send the same run twice on a repeated signed delivery', async () => {
    const s = setup();
    s.seed('first');
    await s.deliver('first');
    const again = await s.deliver('first', { at: NOW + 1000 });
    expect(await again.json()).toMatchObject({ ok: true, suppressed: 'unchanged-weekly-evidence' });
    expect(s.sent).toHaveLength(1);
    expect(s.d1.db.prepare('SELECT COUNT(*) n FROM reports').get()?.n).toBe(1);
    expect(s.d1.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n).toBe(1);
  });
  it('suppresses another generation with unchanged life facts despite different system cost and prose', async () => {
    const s = setup();
    s.seed('first');
    await s.deliver('first');
    const fixture = conciseFixture();
    fixture.system.costs.month.estimatedUsd = 8.9;
    fixture.system.runs.total = 80;
    s.seed('second', fixture, NOW + 1000);
    const again = await s.deliver('second', { amount: 9999, at: NOW + 1000 });
    expect(await again.json()).toMatchObject({ suppressed: 'unchanged-weekly-evidence' });
    expect(s.sent).toHaveLength(1);
    expect((await readWeeklyReports(s.env)).report?.text).toContain('100 грн');
    expect((await readWeeklyReports(s.env)).report?.text).not.toContain('9999');
  });
  it('updates the existing overview after changed evidence and deletes only the new bot draft', async () => {
    const s = setup();
    s.seed('first');
    await s.deliver('first');
    const fixture = conciseFixture();
    fixture.finance.summary.expenseMinor = 12500;
    s.seed('second', fixture, NOW + 2000);
    s.drafts.set('second', 77);
    await s.deliver('second', { amount: 125, at: NOW + 2000 });
    expect(s.sent.map((s) => s.method)).toEqual([
      'sendMessage',
      'deleteMessage',
      'editMessageText',
    ]);
    expect(s.sent[1]?.body.message_id).toBe(77);
    expect(s.sent[2]?.body.message_id).toBe(50);
    expect(s.sent[2]?.body.text).toContain('125 грн');
  });
  it('does not overwrite a usable overview with a failed update or leak its provider error', async () => {
    const s = setup();
    s.seed('first');
    await s.deliver('first');
    s.seed('second', conciseFixture(), NOW + 2000);
    await s.deliver('second', { failed: true, at: NOW + 2000 });
    expect(s.sent).toHaveLength(1);
    expect((await readWeeklyReports(s.env)).report?.id).toBe('weekly:first');
    expect(JSON.stringify(await readWeeklyReports(s.env))).not.toContain('PRIVATE');
    expect(
      s.d1.db.prepare("SELECT status FROM reports WHERE id='weekly:second'").get()?.status,
    ).toBe('failed');
  });
  it('drops an obsolete queued overview when newer evidence was sent while it waited for 429', async () => {
    const s = setup();
    s.seed('first');
    s.fetch.mockImplementationOnce(async (url, init) => {
      s.sent.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: false, parameters: { retry_after: 30 } }, { status: 429 });
    });
    await s.deliver('first');
    const fixture = conciseFixture();
    fixture.finance.summary.expenseMinor = 12500;
    s.seed('second', fixture, NOW + 1000);
    await s.deliver('second', { amount: 125, at: NOW + 1000 });
    await drainOutbox(s.env, { nowMs: NOW + 120000 });
    expect(s.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(2); // one 429, one actual send
    expect(s.sent.at(-1)?.body.text).toContain('125 грн');
  });
  it('still delivers an unchanged first overview after 429 when another generation was suppressed', async () => {
    const s = setup();
    s.seed('first');
    s.fetch.mockResolvedValueOnce(
      Response.json({ ok: false, parameters: { retry_after: 30 } }, { status: 429 }),
    );
    await s.deliver('first');
    s.seed('second', conciseFixture(), NOW + 1000);
    await s.deliver('second', { at: NOW + 1000 });
    await drainOutbox(s.env, { nowMs: NOW + 120000 });
    expect(s.sent).toHaveLength(1); // the overridden 429 implementation did not append to this list
    expect(s.sent[0]?.body.text).toContain('100 грн');
    expect(
      s.d1.db.prepare("SELECT status FROM outbox WHERE id='weekly:first:0'").get()?.status,
    ).toBe('sent');
  });
});
