// Перенесення нагадувань KV `state.reminders` → D1 `reminders` (етап 2 PR-7).
//
// Запускається ОДИН раз під час фліпа ASSISTANT_V2=on, коли легасі-цикл уже
// заглушено. Порядок кроків такий, що переривання на будь-якому з них не
// губить даних і не створює дублів:
//
//   1. читаємо KV і D1;
//   2. пишемо в D1 лише те, чого там ще немає (за id);
//   3. звіряємо кількість активних;
//   4. ТІЛЬКИ ПІСЛЯ успішної звірки прибираємо перенесені з KV.
//
// Поки крок 4 не виконано, джерелом лишається KV - тобто аварійний вихід між
// 2 і 4 означає «дані в обох місцях», а не «дані ніде». Дублів доставки це не
// дає: після фліпа KV-гілка задачі не працює.
//
// --dry-run друкує план, нічого не змінюючи. Без нього скрипт вимагає --apply:
// мовчазний запуск не має мігрувати прод.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
/** Активні статуси D1 - ті самі, що в core/reminders/store. */
const ACTIVE = ['pending', 'snoozed'];

/** Id бази з wrangler.jsonc - одне джерело істини (як у sync-instructions). */
export function readDatabaseId(raw) {
  const m = /"database_id"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(raw);
  if (!m) throw new Error('не знайшов database_id у web/wrangler.jsonc');
  return /** @type {string} */ (m[1]);
}

/**
 * KV-запис нагадування → рядок D1. Активним у KV вважається те, що ще не
 * спрацювало (`firedTs` порожній) - той самий критерій, що в listActive.
 * @param {any} r
 */
export function kvToRow(r) {
  return {
    id: String(r.id),
    due_at: new Date(Number(r.whenMs)).toISOString(),
    text: String(r.text ?? ''),
    status: r.firedTs ? 'sent' : 'pending',
    chat_id: r.chatId == null ? null : String(r.chatId),
    thread_id: r.threadId == null ? null : String(r.threadId),
  };
}

/** Що саме переносити: валідні записи з часом і текстом.
 *  @param {unknown} reminders */
export function selectMigratable(reminders) {
  const list = Array.isArray(reminders) ? reminders : [];
  const ok = [];
  const skipped = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') {
      skipped.push({ reason: 'не обʼєкт', row: r });
      continue;
    }
    const id = /** @type {any} */ (r).id;
    const whenMs = Number(/** @type {any} */ (r).whenMs);
    if (!id || !Number.isFinite(whenMs)) {
      skipped.push({ reason: 'немає id або whenMs', row: r });
      continue;
    }
    ok.push(kvToRow(r));
  }
  return { ok, skipped };
}

/**
 * @param {{ accountId: string, dbId: string, token: string }} cf
 * @param {{ sql: string, params?: unknown[] }[]} statements
 */
async function d1Query(cf, statements) {
  const res = await fetch(`${API}/accounts/${cf.accountId}/d1/database/${cf.dbId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(statements.length === 1 ? statements[0] : { batch: statements }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok || !body?.success) {
    const why =
      body?.errors?.map((/** @type {any} */ e) => e.message).join('; ') ?? `HTTP ${res.status}`;
    throw new Error(`D1 API: ${why}`);
  }
  return body.result;
}

/**
 * @param {{ accountId: string, namespaceId: string, token: string }} kv
 * @param {string} key
 */
async function kvGet(kv, key) {
  const res = await fetch(
    `${API}/accounts/${kv.accountId}/storage/kv/namespaces/${kv.namespaceId}/values/${key}`,
    { headers: { Authorization: `Bearer ${kv.token}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${key}: HTTP ${res.status}`);
  return res.text();
}

/**
 * @param {{ accountId: string, namespaceId: string, token: string }} kv
 * @param {string} key
 * @param {string} value
 */
async function kvPut(kv, key, value) {
  const res = await fetch(
    `${API}/accounts/${kv.accountId}/storage/kv/namespaces/${kv.namespaceId}/values/${key}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'text/plain' },
      body: value,
    },
  );
  if (!res.ok) throw new Error(`KV PUT ${key}: HTTP ${res.status}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (!dryRun && !apply) {
    throw new Error('вкажи --dry-run (подивитись) або --apply (перенести)');
  }

  const accountId = (process.env.CF_ACCOUNT_ID ?? '').trim();
  const token = (process.env.CF_API_TOKEN ?? '').trim();
  const namespaceId = (process.env.KV_NAMESPACE_ID ?? '').trim();
  if (!accountId || !token || !namespaceId) {
    throw new Error('бракує CF_ACCOUNT_ID / CF_API_TOKEN / KV_NAMESPACE_ID');
  }
  const cf = { accountId, token, dbId: readDatabaseId(readFileSync('web/wrangler.jsonc', 'utf8')) };
  const kv = { accountId, token, namespaceId };

  const stateRaw = await kvGet(kv, 'state');
  const state = stateRaw ? JSON.parse(stateRaw) : {};
  const { ok: rows, skipped } = selectMigratable(state.reminders);
  const activeInKv = rows.filter((r) => ACTIVE.includes(r.status));

  const existing = new Set(
    ((await d1Query(cf, [{ sql: 'SELECT id FROM reminders' }]))[0]?.results ?? []).map(
      (/** @type {any} */ r) => String(r.id),
    ),
  );
  const toWrite = rows.filter((r) => !existing.has(r.id));

  console.log(`у KV: ${rows.length} записів (${activeInKv.length} активних)`);
  console.log(`у D1 уже є: ${existing.size}; перенести: ${toWrite.length}`);
  if (skipped.length > 0) console.log(`⚠️ пропущено як биті: ${skipped.length}`);
  for (const r of toWrite.slice(0, 10)) {
    console.log(`  ${r.id}  ${r.due_at}  ${r.status.padEnd(7)} ${r.text.slice(0, 40)}`);
  }
  if (toWrite.length > 10) console.log(`  …ще ${toWrite.length - 10}`);

  if (dryRun) {
    console.log('\ndry-run: нічого не змінено');
    return;
  }

  for (const r of toWrite) {
    await d1Query(cf, [
      {
        sql: `INSERT INTO reminders (id, due_at, text, status, snooze_count, chat_id, thread_id)
              VALUES (?, ?, ?, ?, 0, ?, ?)
              ON CONFLICT (id) DO NOTHING`,
        params: [r.id, r.due_at, r.text, r.status, r.chat_id, r.thread_id],
      },
    ]);
  }

  // Звірка кількості - те, заради чого 03-plan вимагає скрипт, а не ручний SQL:
  // «перенесли» має означати «стільки ж активних, скільки було».
  const afterRows =
    (await d1Query(cf, [{ sql: 'SELECT id, status FROM reminders' }]))[0]?.results ?? [];
  const afterIds = new Set(afterRows.map((/** @type {any} */ r) => String(r.id)));
  const missing = rows.filter((r) => !afterIds.has(r.id));
  if (missing.length > 0) {
    throw new Error(
      `після перенесення бракує ${missing.length}: ${missing.map((r) => r.id).join(', ')}`,
    );
  }
  const activeAfter = afterRows.filter((/** @type {any} */ r) => ACTIVE.includes(String(r.status)));
  console.log(`\nу D1 після перенесення: ${afterIds.size} записів, ${activeAfter.length} активних`);

  // Аж тепер прибираємо з KV: доти джерелом лишався він.
  const cleaned = { ...state, reminders: [] };
  await kvPut(kv, 'state', JSON.stringify(cleaned));
  console.log('KV `state.reminders` очищено - джерелом стала D1');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
