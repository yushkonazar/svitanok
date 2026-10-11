import { loadSettings, loadStats } from '../../kv-store.mjs';
import { kyivParts, shiftDate } from '../finance/planning.mjs';
import {
  CHECKIN_WINDOW_SLOTS,
  checkinWindow,
  checkinWindowOpen,
  checkinOpenButton,
} from './windows.mjs';
import { tgCall } from '../../telegram-client.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { shouldDeliverProactive } from '../assistant-controls.mjs';
import { readMiniAppNotificationSettings } from '../finance/reminders.mjs';

/** Missing additive migration disables only extension, never the existing check-in.
 * @param {Env} env */
async function available(env) {
  return Boolean(
    env.DB &&
    (await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='checkin_extensions'",
    )
      .bind()
      .first()),
  );
}
/** @param {Env} env @param {unknown} prefs @param {number} nowMs */
export async function checkinWindows(env, prefs, nowMs) {
  const today = kyivParts(nowMs).date,
    previous = shiftDate(today, -1);
  const enabled = await available(env);
  const rows =
    enabled && env.DB
      ? (
          await env.DB.prepare('SELECT * FROM checkin_extensions WHERE date_key IN (?,?)')
            .bind(previous, today)
            .all()
        ).results
      : [];
  return [previous, today]
    .flatMap((date) =>
      CHECKIN_WINDOW_SLOTS.map((slot) => {
        const w = checkinWindow(date, slot, prefs);
        const row = rows.find((r) => r.date_key === date && r.slot === slot);
        // A changed global schedule cannot inherit an old deadline or buy another hour.
        if (
          row?.schedule_key === w.key &&
          row.base_end === w.baseEnd &&
          Date.parse(String(row.end_at)) === Date.parse(w.baseEnd) + 3600000
        ) {
          w.extended = true;
          w.endAt = String(row.end_at);
        }
        return { ...w, extensionAvailable: enabled && !row, open: checkinWindowOpen(w, nowMs) };
      }),
    )
    .filter((w) => w.dateKey === today || w.open);
}
/** Atomic one-time insert: simultaneous Mini App / Telegram taps cannot compound.
 * Only before the original closing time, only for an unconfirmed open slot.
 * @param {Env} env @param {{dateKey:string,slot:string,key:string}} target @param {number} nowMs */
export async function extendCheckin(env, target, nowMs) {
  if (!target || !/^[0-9a-f]{8}$/.test(target.key ?? ''))
    return { ok: false, error: 'Онови чек-ін і спробуй ще раз.' };
  const prefs = (await loadSettings(env)).checkin;
  const windows = await checkinWindows(env, prefs, nowMs);
  const w = windows.find(
    (w) => w.dateKey === target.dateKey && w.slot === target.slot && w.key === target.key,
  );
  if (!w?.open) return { ok: false, error: 'Цей чек-ін уже закритий. Відкрий актуальний.' };
  const store = await loadStats(env);
  if (store.checkins?.[w.dateKey]?.[w.slot]?.confirmed)
    return { ok: false, error: 'Цей чек-ін уже підтверджений.' };
  if (w.extended) return { ok: true, alreadyExtended: true, window: w };
  if (nowMs >= Date.parse(w.baseEnd))
    return { ok: false, error: 'Час продовження цього чек-іну минув.' };
  if (!w.extensionAvailable || !env.DB)
    return { ok: false, error: 'Продовження зараз недоступне. Загальний розклад не змінено.' };
  const endAt = new Date(Date.parse(w.baseEnd) + 3600000).toISOString();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO checkin_extensions(date_key,slot,schedule_key,base_end,end_at,created_at) VALUES(?,?,?,?,?,?)`,
  )
    .bind(w.dateKey, w.slot, w.key, w.baseEnd, endAt, new Date(nowMs).toISOString())
    .run();
  const latestPrefs = (await loadSettings(env)).checkin;
  const after = (await checkinWindows(env, latestPrefs, nowMs)).find(
    (v) => v.dateKey === w.dateKey && v.slot === w.slot,
  );
  if (!after?.extended) return { ok: false, error: 'Не вдалося продовжити чек-ін. Онови екран.' };
  return { ok: true, alreadyExtended: Number(result.meta.changes) === 0, window: after };
}
/** @param {string} iso */
export function checkinDeadlineLabel(iso) {
  return new Date(iso).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
/** Revalidate queued nudges at delivery: do not send a closed/completed card,
 * and show the updated deadline if an extension happened while queued.
 * @param {Env} env @param {{dateKey:string,slot:string,key:string}} target @param {number} nowMs @param {string|number|null} chatId */
export async function renderCheckinNotice(env, target, nowMs, chatId) {
  const settings = await loadSettings(env),
    prefs = settings.checkin;
  const notificationSettings = await readMiniAppNotificationSettings(env);
  const local = kyivParts(nowMs);
  if (
    (notificationSettings && !notificationSettings.checkin_reminders) ||
    isQuietMinute(settings, local.hour * 60 + local.minute) ||
    !(await shouldDeliverProactive(env, 'nudge', nowMs)).deliver
  )
    return null;
  const w = (await checkinWindows(env, prefs, nowMs)).find(
    (w) => w.dateKey === target.dateKey && w.slot === target.slot && w.key === target.key && w.open,
  );
  if (!w || (await loadStats(env)).checkins?.[w.dateKey]?.[w.slot]?.confirmed) return null;
  return checkinNoticePayload(env, w, chatId);
}
/** @param {Env} env @param {import('./windows.mjs').CheckinWindow & {extensionAvailable:boolean}} w @param {string|number|null} chatId */
export function checkinNoticePayload(env, w, chatId) {
  const names = { morning: 'Ранковий', afternoon: 'Денний', evening: 'Вечірній' };
  const open = checkinOpenButton(env, w.dateKey, w.slot, chatId);
  /** @type {Record<string,unknown>[][]} */ const buttons = open ? [[open]] : [];
  if (w.extensionAvailable)
    buttons.push([
      { text: 'Ще годину', callback_data: `ci:extend:${w.dateKey}:${w.slot}:${w.key}` },
    ]);
  return {
    text: `${names[w.slot]} чек-ін відкритий до ${checkinDeadlineLabel(w.endAt)}.`,
    reply_markup: { inline_keyboard: buttons },
  };
}
/** @param {Env} env @param {{data?:unknown,chatId?:number|null,messageId?:number|null}} parsed @param {number} nowMs */
export async function checkinExtensionCallback(env, parsed, nowMs) {
  const match = /^ci:extend:(\d{4}-\d{2}-\d{2}):(morning|afternoon|evening):([0-9a-f]{8})$/.exec(
    String(parsed.data ?? ''),
  );
  if (!match?.[1] || !match[2] || !match[3]) return 'Ця кнопка вже неактуальна.';
  let result;
  try {
    result = await extendCheckin(env, { dateKey: match[1], slot: match[2], key: match[3] }, nowMs);
  } catch {
    return 'Не вдалося продовжити чек-ін. Спробуй ще раз.';
  }
  if (!result.ok || !result.window) return result.error ?? 'Не вдалося продовжити чек-ін.';
  const open = checkinOpenButton(
    env,
    result.window.dateKey,
    result.window.slot,
    parsed.chatId ?? null,
  );
  try {
    if (parsed.chatId != null && parsed.messageId != null) {
      const response = await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: `Чек-ін продовжено до ${checkinDeadlineLabel(result.window.endAt)}. Відповіді ще потрібно підтвердити.`,
        reply_markup: { inline_keyboard: open ? [[open]] : [] },
      });
      if (!response.ok) {
        return result.alreadyExtended
          ? 'Уже продовжено на годину.'
          : 'Чек-ін продовжено. Не вдалося оновити картку — відкрий Mini App.';
      }
    }
  } catch {
    return 'Чек-ін продовжено. Не вдалося оновити картку — відкрий Mini App.';
  }
  return result.alreadyExtended ? 'Уже продовжено на годину.' : 'Продовжено на годину.';
}
