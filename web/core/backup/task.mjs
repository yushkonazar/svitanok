// Задача планувальника `backup` (07 §7, 05-ops §«Бекапи», етап 3 PR-6):
// неділя 03:00 Києва - знімок D1 (усі таблиці) + KV (усі ключі, крім кешу
// токена) → JSON → AES-256-GCM (BACKUP_ENC_KEY) → Drive «Світанок/backups/
// svitanok-YYYY-MM-DD.enc» через drive.file. Успіх тихий: хеш і розмір у
// facts.setting.last_backup. Збій - алерт у TOPIC_SYSTEM одразу; о 04:00 без
// файлу - ще один алерт «бекап не зроблено» (05-ops §алерти). Кожної 13-ї
// неділі - нагадування про тестове відновлення в локальну D1.
//
// Відхилення від 05-ops названо: тека «backups/svitanok-<дата>.enc» замість
// «backups/<дата>/svitanok-<env>.enc» - дата в імені файлу, один рівень тек
// менше; KV-знімок іде в той самий файл, не окремим архівом.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { runFactsSet } from '../tools/facts.mjs';
import { ensureFolderPath, uploadFile } from '../adapters/drive.mjs';
import {
  assistantHistorySnapshot,
  mutableStateSnapshot,
  sentMessagesSnapshot,
} from '../../kv-store.mjs';
import {
  buildBackupDocument,
  encryptBackup,
  sha256Hex,
  summarizeBackup,
  BACKUP_TABLES,
} from './core.mjs';

export const BACKUP_STATE_KEY = 'backupState';
export const BACKUP_HOUR = 3;
export const BACKUP_DEADLINE_HOUR = 4;
export const BACKUP_MAX_ATTEMPTS = 3;
export const BACKUP_FOLDER_PATH = ['Світанок', 'backups'];
/** Стеля рядків на таблицю у знімку - страховка від розростання (runs за 90
 *  днів - сотні, outbox чиститься; більше - привід подивитись, не мовчати). */
export const BACKUP_ROWS_PER_TABLE = 50_000;

/**
 * @typedef {{ date: string, attempts: number, done: boolean, alertedMissing: boolean }} BackupState
 */

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function backupTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const today = kyivDateKey(now);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 0) return { skipped: 'not-sunday' };
  const hour = kyivHour(now);
  if (hour < BACKUP_HOUR) return { skipped: 'hour' };

  const state = await readState(env, today);
  if (state.done) return { skipped: 'done' };

  if (hour >= BACKUP_DEADLINE_HOUR) {
    // Вікно минуло без файлу: один алерт «не зроблено», далі - тиша до
    // наступної неділі (ручний запуск - scripts/backup.mjs у 05-ops).
    if (state.alertedMissing) return { skipped: 'missed' };
    await sendSystemAlert(
      env,
      `Бекап ${today} не зроблено (спроб: ${state.attempts}) - перевір Drive/ключ.`,
      nowMs,
    );
    await writeState(env, { ...state, alertedMissing: true });
    return { alertedMissing: true };
  }
  if (state.attempts >= BACKUP_MAX_ATTEMPTS) return { skipped: 'attempts' };

  try {
    const result = await runBackup(env, nowMs, today);
    await writeState(env, { ...state, attempts: state.attempts + 1, done: true });
    if (isQuarterlySunday(today)) {
      await sendSystemAlert(
        env,
        `Квартальне нагадування: перевір відновлення бекапу в локальну D1 (scripts/restore.mjs --file <enc> --dry-run, далі --local).`,
        nowMs,
      );
    }
    return { done: true, ...result };
  } catch (/** @type {any} */ e) {
    const attempts = state.attempts + 1;
    console.error(`backup: спроба ${attempts} впала`, e?.message);
    await sendSystemAlert(
      env,
      `Бекап ${today}: спроба ${attempts} впала - ${String(e?.message ?? 'збій').slice(0, 200)}.`,
      nowMs,
    );
    await writeState(env, { ...state, attempts });
    return { failed: true, attempts };
  }
}

/**
 * Власне бекап: читання → документ → шифр → Drive → відбиток у facts.
 * Помилка на будь-якому кроці - виняток (викликач алертить).
 * @param {Env} env
 * @param {number} nowMs
 * @param {string} today
 */
export async function runBackup(env, nowMs, today) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  const secret = String(env.BACKUP_ENC_KEY ?? '');
  if (!secret) throw new Error('BACKUP_ENC_KEY не задано');

  const tables = await dumpTables(env);
  const kv = await dumpKv(env);
  // Structured state (`state`/`stats`/`settings`) може бути новішим за legacy
  // KV mirror. Під час rollout StateStoreDO є canonical, тому бекап
  // підміняє ці ключі його snapshot-ом; решта KV лишається як є.
  const [mutable, sentMessages, assistantHistory] = await Promise.all([
    mutableStateSnapshot(env),
    sentMessagesSnapshot(env),
    assistantHistorySnapshot(env),
  ]);
  if (mutable) {
    kv.state = JSON.stringify(mutable.state);
    kv.stats = JSON.stringify(mutable.stats);
    kv.settings = JSON.stringify(mutable.settings);
  }
  if (sentMessages) kv.sentMessages = JSON.stringify(sentMessages);
  if (assistantHistory) kv.assistantHistory = JSON.stringify(assistantHistory);
  const doc = buildBackupDocument({
    createdMs: nowMs,
    envName: String(env.ASSISTANT_V2 ?? 'unknown'),
    tables,
    kv,
  });
  const bytes = await encryptBackup(secret, doc);
  const sha256 = await sha256Hex(bytes);
  const folderId = await ensureFolderPath(env, BACKUP_FOLDER_PATH);
  const uploaded = await uploadFile(env, {
    name: `svitanok-${today}.enc`,
    parentId: folderId,
    bytes,
  });
  const summary = summarizeBackup(doc);
  // Відбиток - у facts (05-ops §перевірка): дата, хеш, розмір, id у Drive.
  // Це перевірена подія server-side, не слово власника й не висновок моделі.
  await runFactsSet(
    env,
    {
      kind: 'setting',
      key: 'last_backup',
      value: { date: today, sha256, bytes: bytes.length, drive_id: uploaded.id, ...summary },
      source: 'observed_event',
      confidence: 1,
      observed_at: new Date(nowMs).toISOString(),
    },
    nowMs,
  );
  return { sha256, bytes: bytes.length, driveId: uploaded.id, ...summary };
}

/** Знімок усіх таблиць - спільний для бекапу (нд 03:00) і експорту даних
 *  (S-0-6): один список і один читач, інакше вони розійдуться.
 *  @param {Env} env */
export async function dumpTables(env) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  /** @type {Record<string, Record<string, unknown>[]>} */
  const out = {};
  // Один batch замість 30 послідовних запитів: імена таблиць - з константного
  // списку, не з вводу.
  const pages = await db.batch(
    BACKUP_TABLES.map((table) =>
      db.prepare(`SELECT * FROM ${table} LIMIT ${BACKUP_ROWS_PER_TABLE + 1}`).bind(),
    ),
  );
  BACKUP_TABLES.forEach((table, i) => {
    const rows = /** @type {Record<string, unknown>[]} */ (pages[i]?.results ?? []);
    if (rows.length > BACKUP_ROWS_PER_TABLE) {
      throw new Error(`таблиця ${table} понад ${BACKUP_ROWS_PER_TABLE} рядків - бекап зупинено`);
    }
    out[table] = rows;
  });
  return out;
}

/**
 * Усі ключі KV зі значеннями (сирі рядки). list() сторінковий - тягнемо до
 * кінця; ключів у неймспейсі - десятки.
 * @param {Env} env
 */
export async function dumpKv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = /** @type {any} */ (await env.BRIEFING.list(cursor ? { cursor } : {}));
    for (const k of page.keys ?? []) {
      const name = String(k.name);
      const value = await env.BRIEFING.get(name);
      if (value != null) out[name] = value;
    }
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Кожна 13-та неділя за ISO-тижнем: нагадування про тестове відновлення. @param {string} dateKey */
export function isQuarterlySunday(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  // ISO-тиждень: четвер того ж тижня визначає рік.
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return week % 13 === 0;
}

/**
 * @param {Env} env
 * @param {string} today
 * @returns {Promise<BackupState>}
 */
async function readState(env, today) {
  const fresh = { date: today, attempts: 0, done: false, alertedMissing: false };
  try {
    const raw = await env.BRIEFING.get(BACKUP_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.date !== today) return fresh;
    return {
      date: today,
      attempts: Number(parsed.attempts) || 0,
      done: Boolean(parsed.done),
      alertedMissing: Boolean(parsed.alertedMissing),
    };
  } catch {
    return fresh;
  }
}

/** @param {Env} env @param {BackupState} state */
async function writeState(env, state) {
  await env.BRIEFING.put(BACKUP_STATE_KEY, JSON.stringify(state));
}
