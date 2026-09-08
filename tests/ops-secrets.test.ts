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
import {
  SECRETS,
  DATED_SECRETS,
  daysLeft,
  stageFor,
  expiryText,
  unknownText,
  ROTATED_KEY_PREFIX,
  EXPIRY_STATE_KEY,
  UNKNOWN_MARK_KEY,
} from '../web/core/ops/secrets.mjs';
import {
  secretExpiryTask,
  SECRET_EXPIRY_HOUR,
  SECRET_EXPIRY_MARKER,
} from '../web/core/ops/secret-expiry.mjs';
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
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0003_telemetry.sql']);
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
      expect(cells[3]).toBe(secret.periodDays == null ? 'за подією' : `${secret.periodDays} дн.`);
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
    expect(onlyInExport).toEqual([
      'WEATHER_API_KEY',
      'NEWSDATA_API_KEY',
      'INTERNAL_HMAC_KEY_NEXT',
      'LLM_HOST_SECRET',
    ]);
  });
});

describe('daysLeft і пороги', () => {
  const dated = DATED_SECRETS[0]!;

  it('без запису про ротацію - null, а не «сьогодні»', () => {
    expect(daysLeft(dated, null, NOW)).toBeNull();
    expect(daysLeft(dated, 'учора', NOW)).toBeNull();
  });

  it('секрет без строку не «закінчується» ніколи', () => {
    const eventOnly = SECRETS.find((s) => s.periodDays == null)!;
    expect(daysLeft(eventOnly, new Date(NOW - 5 * 365 * DAY).toISOString(), NOW)).toBeNull();
  });

  it('поріг спрацьовує від ПЕРШОГО дня, коли залишок менший (пропуск доби не губить)', () => {
    expect(stageFor(31, null)).toBeNull();
    expect(stageFor(30, null)).toBe(30);
    expect(stageFor(25, null)).toBe(30); // задача пропустила тиждень - нагадування не втрачене
    expect(stageFor(30, 30)).toBeNull(); // уже казали
    expect(stageFor(7, 30)).toBe(7);
    expect(stageFor(-3, 7)).toBeNull(); // після 7 більше не повторюємо
  });

  it('текст називає секрет, місце і що робити', () => {
    expect(expiryText(dated, 7, 7)).toContain(dated.name);
    expect(expiryText(dated, 7, 7)).toContain('docs/ops/secrets.md');
    expect(expiryText(dated, -2, 7)).toContain('строк вийшов 2 дн. тому');
    expect(unknownText(['A', 'B'])).toContain('Вигадувати дату не буду');
  });
});

describe('secret-expiry', () => {
  it('за 30 днів - один алерт; наступного дня мовчить', async () => {
    const rotated = new Date(NOW - (365 - 30) * DAY).toISOString();
    const { env } = makeEnv({ [`${ROTATED_KEY_PREFIX}MAPS_API_KEY`]: rotated });
    const sent = stubTelegram();
    await secretExpiryTask(env, NOW);
    expect(sent.filter((t) => t.includes('MAPS_API_KEY'))).toHaveLength(1);
    // Наступна доба: мітка іншого дня, але поріг уже пройдений.
    sent.length = 0;
    await secretExpiryTask(env, NOW + DAY);
    expect(sent.filter((t) => t.includes('MAPS_API_KEY'))).toHaveLength(0);
  });

  it('за 7 днів - другий алерт попри перший', async () => {
    const { env } = makeEnv({
      [`${ROTATED_KEY_PREFIX}MAPS_API_KEY`]: new Date(NOW - (365 - 7) * DAY).toISOString(),
      [EXPIRY_STATE_KEY]: { MAPS_API_KEY: 30 },
    });
    const sent = stubTelegram();
    await secretExpiryTask(env, NOW);
    expect(sent.some((t) => t.includes('MAPS_API_KEY') && t.includes('поріг 7'))).toBe(true);
  });

  it('секрети без дати - один спільний рядок, не по одному на кожен', async () => {
    const { env } = makeEnv();
    const sent = stubTelegram();
    const out = await secretExpiryTask(env, NOW);
    expect(out).toMatchObject({ unknown: DATED_SECRETS.length });
    const unknownMsgs = sent.filter((t) => t.includes('Не знаю дати ротації'));
    expect(unknownMsgs).toHaveLength(1);
    expect(unknownMsgs[0]).toContain('MAPS_API_KEY');
  });

  it('про невідомі дати не нагадує щодня (мітка на 30 діб)', async () => {
    const { env } = makeEnv({ [UNKNOWN_MARK_KEY]: new Date(NOW - 5 * DAY).toISOString() });
    const sent = stubTelegram();
    await secretExpiryTask(env, NOW);
    expect(sent.some((t) => t.includes('Не знаю дати ротації'))).toBe(false);
  });

  it('зайвий скоуп Google - алерт; рівно ті скоупи - тиша', async () => {
    const extra = new Map<string, string>([
      [
        'googleToken',
        JSON.stringify({
          token: 'AT',
          expMs: TOKEN_EXP(),
          scope: [...CORE_SCOPES, 'https://www.googleapis.com/auth/gmail.send'].join(' '),
        }),
      ],
    ]);
    const { env } = makeEnv({}, { BRIEFING: memoryKv(extra) });
    const sent = stubTelegram();
    const out = await secretExpiryTask(env, NOW);
    expect(out).toMatchObject({ scopes: 'extra' });
    expect(sent.some((t) => t.includes('gmail.send'))).toBe(true);

    const { env: clean } = makeEnv();
    const quiet = stubTelegram();
    expect(await secretExpiryTask(clean, NOW)).toMatchObject({ scopes: 'ok' });
    expect(quiet.some((t) => t.includes('зайвих скоупів'))).toBe(false);
  });

  it('про зайві скоупи - раз на 30 діб, не щодня', async () => {
    // Токен із зайвим скоупом живе, доки власник не перевидасть його руками,
    // тобто тижнями. Щоденне «⚠️ Токен Google має 3 зайвих скоупів» він
    // вимкне на третій день - разом із рештою алертів (ревʼю виправлень).
    const scope = [...CORE_SCOPES, 'https://www.googleapis.com/auth/gmail.send'].join(' ');
    const store = new Map<string, string>([
      ['googleToken', JSON.stringify({ token: 'AT', expMs: TOKEN_EXP(), scope })],
    ]);
    const { env } = makeEnv({}, { BRIEFING: memoryKv(store) });
    const sent = stubTelegram();
    expect(await secretExpiryTask(env, NOW)).toMatchObject({ scopes: 'extra' });
    // Наступна доба: мітка інша, скоупи ті самі - тиша.
    expect(await secretExpiryTask(env, NOW + DAY)).toMatchObject({ scopes: 'extra-quiet' });
    expect(sent.filter((t) => t.includes('зайвих прав'))).toHaveLength(1);
  });

  it('поза годиною і вдруге за добу - нічого', async () => {
    const { env, store } = makeEnv();
    stubTelegram();
    expect(await secretExpiryTask(env, NOW - 3 * 3_600_000)).toEqual({ skipped: 'hour' });
    await secretExpiryTask(env, NOW);
    expect(store.get(SECRET_EXPIRY_MARKER)).toBe('2026-09-08');
    expect(await secretExpiryTask(env, NOW + 60_000)).toEqual({ skipped: 'done' });
  });

  it('година перевірки - 10:00 Києва', () => {
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
    expect(sent.some((t) => t.includes('gemini_usd'))).toBe(true);
    expect(store.get(QUOTA_CHECK_MARKER)).toBe('2026-09-08');
    expect(await quotaCheckTask(env, at + 60_000)).toEqual({ skipped: 'done' });
  });
});
