// Строки секретів і платні лічильники (етап 7 PR-5, 07 §7, 05-ops §2-3).
//
// ДВІ РЕЧІ, ЯКІ ТУТ ВАЖЛИВІ.
//   1. Дати НЕ ВИГАДУЮТЬСЯ. Немає запису про ротацію - асистент каже «не
//      знаю», а не рахує від сьогодні: нагадування, якому вірять помилково,
//      гірше за відсутнє.
//   2. Документ і код не розходяться. Таблиця в docs/ops/secrets.md
//      генерується з того самого списку, за яким рахуються нагадування, і
//      звіряється тут - інакше runbook почне описувати систему, якої немає.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRETS, ROTATED_KEY_PREFIX } from '../web/core/ops/secrets.mjs';
import {
  secretExpiryTask,
  SECRET_EXPIRY_HOUR,
  SECRET_EXPIRY_MARKER,
} from '../web/core/ops/secret-expiry.mjs';
import { CREDENTIALS, saveCredentialMetadata } from '../web/core/ops/credentials.mjs';
import { googleGrantIdentity } from '../web/core/google-scopes.mjs';
import {
  quotaCheckTask,
  quotaFindings,
  quotaText,
  daysInMonthOf,
  PAID_KEYS,
  QUOTA_CHECK_MARKER,
} from '../web/core/ops/quota-check.mjs';
import { CORE_SCOPES } from '../web/core/google-scopes.mjs';
import { SECRET_ENV_NAMES } from '../web/core/export/data-export.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const DAY = 86_400_000;
/** 10:00 Києва 8 вересня 2026 (EEST = UTC+3). */
const NOW = Date.parse('2026-09-08T07:00:00.000Z');
// ⚠️ expMs - від РЕАЛЬНОГО годинника, не від NOW: свіжість кешу токена
// перевіряє googleAccessToken за Date.now(), тож привʼязка до фіксованого
// NOW робила б тест бомбою сповільненої дії - зеленим уранці й червоним
// пополудні.
const TOKEN_EXP = () => Date.now() + 3_600_000;

function makeEnv(facts: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  store.set(
    'googleToken',
    JSON.stringify({ token: 'AT', expMs: TOKEN_EXP(), scope: CORE_SCOPES.join(' ') }),
  );
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0003_telemetry.sql',
    '0037_credential_metadata.sql',
    '0046_credential_expiry_kind.sql',
  ]);
  for (const [key, value] of Object.entries(facts)) {
    d1.db
      .prepare(
        `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
         VALUES (?, 'setting', ?, ?, 'inferred', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(`f-${key}`, key, JSON.stringify(value));
  }
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_SYSTEM: '7',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    BRIEFING: memoryKv(store),
    DB: d1.stub,
    ...over,
  });
  return { env, d1, store };
}

/** Стаб Telegram: збирає тексти алертів. */
function stubTelegram() {
  const sent: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}'));
      if (typeof body.text === 'string') sent.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  });
  return sent;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('реєстр секретів і документ', () => {
  it('таблиця в docs/ops/secrets.md збігається зі списком у коді', () => {
    const md = readFileSync(join(__dirname, '..', 'docs', 'ops', 'secrets.md'), 'utf8');
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) => l.split('|').map((c) => c.trim()));
    expect(rows).toHaveLength(SECRETS.length);
    rows.forEach((cells, i) => {
      const secret = SECRETS[i]!;
      expect(cells[1]).toBe(`\`${secret.name}\``);
      expect(cells[2]).toBe(secret.where);
      expect(cells[3]).toBe(
        secret.recommendedRotationDays == null
          ? 'за подією'
          : `${secret.recommendedRotationDays} дн.`,
      );
      expect(cells[4]).toBe(secret.note ?? '');
    });
  });

  it('усе, що чиститься в експорті, є в реєстрі (і навпаки для секретів ядра)', () => {
    // Обидва списки описують ті самі ключі з різних боків; розходження
    // означає або секрет без нагляду, або чистку неіснуючого.
    const registry = new Set(SECRETS.map((s) => s.name));
    const onlyInExport = SECRET_ENV_NAMES.filter(
      (n) => !registry.has(n) && n !== 'GOOGLE_CLIENT_ID' && n !== 'BRAIN_ACCESS_CLIENT_ID',
    );
    // Ті, що чистяться в експорті, але строку ротації не мають: ключі погоди
    // й новин (міняються за подією) та другий HMAC/легасі-хост.
    expect(onlyInExport).toEqual([]);
  });
});

describe('secret-expiry', () => {
  const texts = (d1: ReturnType<typeof makeEnv>['d1']) =>
    d1.db
      .prepare('SELECT payload_json FROM outbox')
      .all()
      .map((row) => JSON.parse(String(row.payload_json)).text as string);
  async function metadata(
    env: Env,
    expiresAt: string | null,
    rotateAfterDays: number | null = null,
  ) {
    await saveCredentialMetadata(
      env,
      {
        id: 'MAPS_API_KEY:cloudflare',
        version: 0,
        rotatedAt: '2026-01-01',
        expiresAt,
        rotateAfterDays,
      },
      NOW,
    );
  }
  async function trustGoogle(value: ReturnType<typeof makeEnv>, at: number, extra: string[] = []) {
    value.store.set(
      'googleToken',
      JSON.stringify({
        token: 'AT',
        expMs: at + 3600000,
        scope: [...CORE_SCOPES, ...extra].join(' '),
        grantIdentity: await googleGrantIdentity(value.env),
        scopeCheckedAt: new Date(at).toISOString(),
      }),
    );
  }
  it('unknown dates and old 365-day rotation facts never generate expiry alerts', async () => {
    const { env, d1 } = makeEnv({ [`${ROTATED_KEY_PREFIX}MAPS_API_KEY`]: '2020-01-01T00:00:00Z' });
    expect(await secretExpiryTask(env, NOW)).toMatchObject({
      reminded: 0,
      unknown: CREDENTIALS.length,
    });
    expect(texts(d1)).toEqual([]);
  });
  it('reminds from a supplied expiry, once per threshold, not once per day', async () => {
    const { env, d1 } = makeEnv();
    await metadata(env, '2026-10-07');
    expect(await secretExpiryTask(env, NOW)).toMatchObject({ reminded: 1 });
    expect(texts(d1)[0]).toContain('Карти й маршрути');
    expect(texts(d1)[0]).not.toContain('MAPS_API_KEY');
    await secretExpiryTask(env, NOW + DAY);
    expect(texts(d1)).toHaveLength(1);
    await secretExpiryTask(env, NOW + 23 * DAY);
    expect(texts(d1)).toHaveLength(2); // seven-day stage
  });
  it('rotation is opt-in and never called key expiry', async () => {
    const { env, d1 } = makeEnv();
    await metadata(env, null, 270);
    await secretExpiryTask(env, NOW);
    expect(texts(d1)[0]).toContain('нагадування про ротацію');
    expect(texts(d1)[0]).toContain('не означає');
  });
  it('records a missed actual expiry without inventing key health or repeating the alarm daily', async () => {
    const { env, d1 } = makeEnv();
    await metadata(env, '2026-09-07');
    expect(await secretExpiryTask(env, NOW)).toMatchObject({ reminded: 1 });
    expect(texts(d1)[0]).toContain('вказаний строк дії вже завершився');
    await secretExpiryTask(env, NOW + DAY);
    expect(texts(d1)).toHaveLength(1);
  });
  it('does not claim a date-only key is already expired during its final calendar day', async () => {
    const { env, d1 } = makeEnv();
    await metadata(env, '2026-09-08');
    await secretExpiryTask(env, NOW);
    expect(texts(d1)[0]).toContain('дата завершення — сьогодні');
    expect(texts(d1)[0]).not.toContain('вже завершився');
  });
  it('warns about verified wider Google access without exposing scope URIs', async () => {
    const value = makeEnv();
    await trustGoogle(value, NOW, ['https://www.googleapis.com/auth/gmail.send']);
    expect(await secretExpiryTask(value.env, NOW)).toMatchObject({ scopes: 'extra' });
    expect(texts(value.d1)[0]).toContain('надсилати пошту');
    expect(texts(value.d1)[0]).not.toMatch(/https:\/\/www.googleapis|scripts\//);
    await trustGoogle(value, NOW + DAY, ['https://www.googleapis.com/auth/gmail.send']);
    expect(await secretExpiryTask(value.env, NOW + DAY)).toMatchObject({ scopes: 'quiet' });
    expect(texts(value.d1)).toHaveLength(1);
  });
  it('an unverified/stale token cache cannot generate a permission alert', async () => {
    const value = makeEnv();
    value.store.set(
      'googleToken',
      JSON.stringify({
        token: 'AT',
        expMs: NOW + 3600000,
        scope: [...CORE_SCOPES, 'https://www.googleapis.com/auth/gmail.send'].join(' '),
      }),
    );
    await secretExpiryTask(value.env, NOW);
    expect(texts(value.d1)).toEqual([]);
  });
  it('outside its hour and repeated runs stay quiet', async () => {
    const { env, store } = makeEnv();
    expect(await secretExpiryTask(env, NOW - 3 * 3600000)).toEqual({ skipped: 'hour' });
    await secretExpiryTask(env, NOW);
    expect(store.get(SECRET_EXPIRY_MARKER)).toBe('2026-09-08');
    expect(await secretExpiryTask(env, NOW + 60000)).toEqual({ skipped: 'done' });
    expect(SECRET_EXPIRY_HOUR).toBe(10);
  });
});

describe('quota-check', () => {
  const month = { dayOfMonth: 10, daysInMonth: 30 };

  it('80 % витраченого - рядок про частку', () => {
    const found = quotaFindings([{ key: 'gemini_usd', value: 8, limit_value: 10 }], month);
    expect(found).toMatchObject([{ key: 'gemini_usd', reason: 'share' }]);
    expect(quotaText(found)).toContain('80 %');
  });

  it('темп веде за стелю - кажемо ЗАРАЗ, не на 80 %', () => {
    // 5 із 10 за 10 днів із 30 → прогноз 15.
    const found = quotaFindings([{ key: 'gemini_usd', value: 5, limit_value: 10 }], month);
    expect(found).toMatchObject([{ reason: 'forecast' }]);
    expect(quotaText(found)).toContain('таким темпом');
  });

  it('спокійний темп - тиша', () => {
    expect(quotaFindings([{ key: 'gemini_usd', value: 1, limit_value: 10 }], month)).toEqual([]);
  });

  it('перші дні місяця прогноз не рахується (одна картинка ≠ 30)', () => {
    const early = quotaFindings([{ key: 'gemini_usd', value: 0.5, limit_value: 10 }], {
      dayOfMonth: 1,
      daysInMonth: 30,
    });
    expect(early).toEqual([]);
  });

  it('до перевірки входить лише gemini_usd', () => {
    // deepgram_min - ЖИТТЄВИЙ кредит $200 (46 500 хв), а лічильники живуть
    // київським місяцем: щоб перетнути 80 % за 30 діб, треба 620 годин аудіо -
    // більше, ніж хвилин у місяці. Щоденна перевірка не сказала б про нього
    // нічого ніколи (ревʼю етапу 7).
    expect(PAID_KEYS).toEqual(['gemini_usd']);
    expect(
      quotaFindings([{ key: 'deepgram_min', value: 46_000, limit_value: 46_500 }], month),
    ).toEqual([]);
    expect(quotaFindings([{ key: 'places_text', value: 4900, limit_value: 5000 }], month)).toEqual(
      [],
    );
  });

  it('днів у місяці - за календарем, не 30 завжди', () => {
    expect(daysInMonthOf('2026-02-15')).toBe(28);
    expect(daysInMonthOf('2026-09-08')).toBe(30);
    expect(daysInMonthOf('2026-01-31')).toBe(31);
  });

  it('задача шле алерт і ставить мітку доби', async () => {
    const { env, d1, store } = makeEnv();
    d1.db.exec(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at)
       VALUES ('gemini_usd', '2026-09', 9, 10, '2026-09-08T00:00:00.000Z')`,
    );
    const sent = stubTelegram();
    // 09:00 Києва = 06:00 UTC.
    const at = Date.parse('2026-09-08T06:00:00.000Z');
    expect(await quotaCheckTask(env, at)).toMatchObject({ findings: 1 });
    expect(sent.some((t) => t.includes('Генерація зображень'))).toBe(true);
    expect(store.get(QUOTA_CHECK_MARKER)).toBe('2026-09-08');
    expect(await quotaCheckTask(env, at + 60_000)).toEqual({ skipped: 'done' });
  });
});
