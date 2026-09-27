// Задача планувальника `backup` (07 §7, 05-ops §«Бекапи», етап 3 PR-6):
// неділя 03:00 Києва - recovery-знімок даних власника з D1 + KV (усі ключі,
// крім кешу токена); короткоживучі runs/run_steps лишаються в D1 telemetry і
// явно виключені з документа → JSON → AES-256-GCM (BACKUP_ENC_KEY) → Drive «Світанок/backups/
// svitanok-YYYY-MM-DD.enc» через drive.file. Успіх тихий: хеш і розмір у
// facts.setting.last_backup. Збій - один зрозумілий алерт у TOPIC_SYSTEM;
// transient failure ще раз підсумовується о 04:00, permanent не ретраїться.
// Кожної 13-ї
// неділі - нагадування про тестове відновлення в локальну D1.
//
// Відхилення від 05-ops названо: тека «backups/svitanok-<дата>.enc» замість
// «backups/<дата>/svitanok-<env>.enc» - дата в імені файлу, один рівень тек
// менше; KV-знімок іде в той самий файл, не окремим архівом.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import {
  backupStateClaim,
  backupStateComplete,
  backupStateRelease,
} from '../backup-state/client.mjs';
import { BACKUP_LEASE_MS, BACKUP_STATE_KEY } from '../backup-state/contract.mjs';
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
  BACKUP_SNAPSHOT_TABLES,
  BACKUP_TELEMETRY_TABLES,
} from './core.mjs';

export { BACKUP_STATE_KEY };
export const BACKUP_HOUR = 3;
export const BACKUP_DEADLINE_HOUR = 4;
export const BACKUP_MAX_ATTEMPTS = 3;
export const BACKUP_FOLDER_PATH = ['Світанок', 'backups'];
/** Стеля рядків на таблицю recovery-знімку - страховка від розростання.
 * Hot telemetry сюди не входить; перевищення для даних власника потребує
 * окремої міграції, а не трьох однакових retry. */
export const BACKUP_ROWS_PER_TABLE = 50_000;

/**
 * @typedef {{ date: string, attempts: number, done: boolean, alertedMissing: boolean,
 *   blocked?: boolean, lastError?: string | null }} BackupState
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

  const legacy = await readState(env, today);
  const claim = await backupStateClaim(env, legacy, nowMs, BACKUP_LEASE_MS);
  if (!claim.ok) return { skipped: claim.reason ?? 'busy' };
  const state = normalizeState(claim.state, today);
  let completed = false;
  /** @param {BackupState} next */
  const writeState = async (next) => {
    const ok = await backupStateComplete(env, claim.token, next);
    if (!ok) throw new Error('backup lease втрачено під час commit');
    completed = true;
  };
  const release = async () => {
    if (!completed && claim.canonical) await backupStateRelease(env, claim.token);
  };
  if (state.done) {
    await release();
    return { skipped: 'done' };
  }

  // Permanent configuration/capacity errors cannot be repaired by retrying in
  // five minutes. Keep the one actionable alert, preserve the cause for
  // /status, and do not turn a deterministic failure into a notification loop.
  if (state.blocked) {
    await release();
    return { skipped: 'blocked' };
  }

  if (hour >= BACKUP_DEADLINE_HOUR) {
    // Вікно минуло без файлу: один алерт «не зроблено», далі - тиша до
    // наступної неділі (ручний запуск - scripts/backup.mjs у 05-ops).
    if (state.alertedMissing) {
      await release();
      return { skipped: 'missed' };
    }
    await sendSystemAlert(
      env,
      `⚠️ Бекап ${today} не зроблено після ${state.attempts} спроб. ${state.lastError ?? 'Останню причину не збережено.'}`,
      nowMs,
    );
    await writeState({ ...state, alertedMissing: true });
    return { alertedMissing: true };
  }
  if (state.attempts >= BACKUP_MAX_ATTEMPTS) {
    await release();
    return { skipped: 'attempts' };
  }

  try {
    const result = await runBackup(env, nowMs, today);
    await writeState({ ...state, attempts: state.attempts + 1, done: true });
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
    const reason = backupErrorReason(e);
    console.error(`backup: спроба ${attempts} впала`, reason);
    if (isPermanentBackupError(e)) {
      await sendSystemAlert(
        env,
        [
          `⚠️ Бекап ${today} заблоковано: ${reason}.`,
          'Повтори зупинено: причина не тимчасова.',
          'Вплив: нової зашифрованої копії цього тижня немає.',
        ].join('\n'),
        nowMs,
      );
      await writeState({
        ...state,
        attempts,
        blocked: true,
        alertedMissing: true,
        lastError: reason,
      });
      return { failed: true, blocked: true, attempts };
    }
    // Тимчасовий збій повідомляємо лише на першій спробі. Далі retry тихий,
    // а після дедлайну буде один підсумок із збереженою реальною причиною.
    if (attempts === 1) {
      await sendSystemAlert(
        env,
        `⚠️ Бекап ${today}: спроба 1 впала — ${reason}. Повторю автоматично.`,
        nowMs,
      );
    }
    await writeState({ ...state, attempts, lastError: reason });
    return { failed: true, attempts };
  }
}

/** Помилка, яку retry ніколи не виправить без зміни конфігурації/даних. */
export class PermanentBackupError extends Error {}

/** @param {unknown} error */
export function isPermanentBackupError(error) {
  return error instanceof PermanentBackupError;
}

/** Не віддаємо у Telegram сирий response/body стороннього сервісу. @param {unknown} error */
export function backupErrorReason(error) {
  return String(error instanceof Error ? error.message : (error ?? 'невідомий збій'))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/**
 * Власне бекап: читання → документ → шифр → Drive → відбиток у facts.
 * Помилка на будь-якому кроці - виняток (викликач алертить).
 * @param {Env} env
 * @param {number} nowMs
 * @param {string} today
 */
export async function runBackup(env, nowMs, today) {
  if (!env.DB) throw new PermanentBackupError('привʼязки DB немає');
  const secret = String(env.BACKUP_ENC_KEY ?? '');
  if (!secret) throw new PermanentBackupError('BACKUP_ENC_KEY не задано');

  // User state is the recovery contract. Hot telemetry (`runs`, `run_steps`)
  // has its own 90-day retention but is intentionally excluded from the
  // encrypted recovery snapshot so it cannot block all backups when it grows.
  const tables = await dumpTables(env, BACKUP_SNAPSHOT_TABLES);
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
    omittedTables: BACKUP_TELEMETRY_TABLES,
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
export async function dumpTables(env, tables = BACKUP_TABLES) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  /** @type {Record<string, Record<string, unknown>[]>} */
  const out = {};
  // Один batch замість 30 послідовних запитів: імена таблиць - з константного
  // списку, не з вводу.
  const pages = await db.batch(
    tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} LIMIT ${BACKUP_ROWS_PER_TABLE + 1}`).bind(),
    ),
  );
  tables.forEach((table, i) => {
    const rows = /** @type {Record<string, unknown>[]} */ (pages[i]?.results ?? []);
    if (rows.length > BACKUP_ROWS_PER_TABLE) {
      throw new PermanentBackupError(
        `таблиця ${table} понад ${BACKUP_ROWS_PER_TABLE} рядків — потрібна окрема міграція даних`,
      );
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
  const fresh = {
    date: today,
    attempts: 0,
    done: false,
    alertedMissing: false,
    blocked: false,
    lastError: null,
  };
  try {
    const raw = await env.BRIEFING.get(BACKUP_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return normalizeState(parsed, today);
  } catch {
    return fresh;
  }
}

/** @param {unknown} value @param {string} today @returns {BackupState} */
function normalizeState(value, today) {
  const fresh = {
    date: today,
    attempts: 0,
    done: false,
    alertedMissing: false,
    blocked: false,
    lastError: null,
  };
  const parsed = /** @type {any} */ (value);
  if (!parsed || parsed.date !== today) return fresh;
  return {
    date: today,
    attempts: Number(parsed.attempts) || 0,
    done: Boolean(parsed.done),
    alertedMissing: Boolean(parsed.alertedMissing),
    blocked: Boolean(parsed.blocked),
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError.slice(0, 240) : null,
  };
}
