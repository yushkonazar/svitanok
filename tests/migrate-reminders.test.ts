// Перенесення нагадувань KV → D1 (етап 2 PR-7). Мережеву частину перевіряє
// сам прогін (він звіряє кількість і чистить KV лише після успішної звірки);
// тут - чисті перетворення, від яких залежить, ЧИ ВЗАГАЛІ доїде нагадування:
// відповідність полів, критерій «активне» і відсів битих записів.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { kvToRow, selectMigratable, readDatabaseId } from '../scripts/migrate-reminders.mjs';

const NOW = Date.parse('2026-08-28T09:00:00.000Z');

describe('kvToRow', () => {
  it('переносить час, текст і адресу; активне лишається pending', () => {
    expect(
      kvToRow({
        id: 'r1',
        text: 'купити хліб',
        whenMs: NOW,
        firedTs: null,
        chatId: 777,
        threadId: 42,
      }),
    ).toEqual({
      id: 'r1',
      due_at: new Date(NOW).toISOString(),
      text: 'купити хліб',
      status: 'pending',
      chat_id: '777',
      thread_id: '42',
    });
  });

  it('спрацьоване стає sent - історія не воскресає', () => {
    // Інакше перенесення заново надіслало б усе, що вже приходило власнику.
    expect(kvToRow({ id: 'r2', text: 'було', whenMs: NOW, firedTs: NOW }).status).toBe('sent');
  });

  it('без адреси - NULL, а не рядок "undefined"', () => {
    const row = kvToRow({ id: 'r3', text: 'x', whenMs: NOW });
    expect(row.chat_id).toBeNull();
    expect(row.thread_id).toBeNull();
  });
});

describe('selectMigratable', () => {
  it('бере валідні, відсіює биті з причиною', () => {
    const { ok, skipped } = selectMigratable([
      { id: 'good', text: 'ок', whenMs: NOW },
      { id: 'no-time', text: 'без часу' },
      { text: 'без id', whenMs: NOW },
      null,
      'сміття',
    ]);
    expect(ok.map((r) => r.id)).toEqual(['good']);
    expect(skipped).toHaveLength(4);
    expect(skipped.every((s) => typeof s.reason === 'string')).toBe(true);
  });

  it('порожнє і не-масив дають порожній результат, а не виняток', () => {
    expect(selectMigratable(undefined).ok).toEqual([]);
    expect(selectMigratable({}).ok).toEqual([]);
    expect(selectMigratable([]).ok).toEqual([]);
  });
});

describe('readDatabaseId', () => {
  it('на справжньому wrangler.jsonc віддає id прив’язки DB', () => {
    const raw = readFileSync(join(__dirname, '..', 'web', 'wrangler.jsonc'), 'utf8');
    const id = readDatabaseId(raw);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw).toMatch(new RegExp(`"binding":\\s*"DB"[\\s\\S]{0,200}${id}`));
  });
});

describe('скрипт як контракт', () => {
  const src = readFileSync(join(__dirname, '..', 'scripts', 'migrate-reminders.mjs'), 'utf8');

  it('не чистить KV раніше за звірку кількості', () => {
    // Порядок кроків - головна гарантія: аварія між записом і чисткою лишає
    // дані в ОБОХ місцях, а не в жодному.
    const verifyAt = src.indexOf('бракує ${missing.length}');
    const cleanAt = src.indexOf("kvPut(kv, 'state'");
    expect(verifyAt).toBeGreaterThan(0);
    expect(cleanAt).toBeGreaterThan(verifyAt);
  });

  it('без явного прапорця нічого не робить', () => {
    expect(src).toContain('--dry-run');
    expect(src).toContain('--apply');
    expect(src).toContain('вкажи --dry-run');
  });

  it('пише лише те, чого в D1 немає (ON CONFLICT DO NOTHING)', () => {
    expect(src).toContain('ON CONFLICT (id) DO NOTHING');
  });
});
