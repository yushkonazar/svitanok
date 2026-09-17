// Пропозиції під ✅/❌ (Фаза 5, модуляризація worker.js, план A2 §5).
//
// ЄДИНИЙ канал змін, які власник має підтвердити перед застосуванням: події
// календаря (створити/змінити/видалити), нагадування-мутації (S2), налаштування,
// новий контакт. Сюди сходяться ОБИДВА джерела — пропозиція від моделі
// (proposeCalendarChanges) і стейджинг кнопкою з /agenda чи пост-accept
// (stageItemEdit/stageItemDelete), — і саме тому вони мусять давати СТРУКТУРНО
// однакові пункти: далі їх обробляє один accept-цикл.
//
// ТРИ ІНВАРІАНТИ.
//   1. `base` домальовується СВІЖИМ читанням перед показом (enrichEventItems):
//      без нього діф «було -> стане» не було б із чим рахувати, а видалення
//      показувало б голий id. Пункт, чия подія вже зникла, дропається — не
//      валить весь пакет.
//   2. Пропозиція живе у ВЛАСНОМУ KV-ключі й списується claim'ом (kv-store):
//      блоб `state` пишуть наївні писарі без merge, і пропозиція, покладена
//      туди, зникала — кожен ✅ падав у «Застаріла» (прод, 19.07).
//   3. Час НІКОЛИ не рахує модель: canonical-рядок -> parseReminderTime
//      (sanitizeProposal). Той самий інваріант, що в P2a.

import { markButtonDone } from './tg-core.mjs';
import {
  sanitizeProposal,
  formatProposalMessage,
  formatProposalResult,
  formatEventEditQuestion,
  buildProposalKeyboard,
  proposalMode,
  cycleProposalDuration,
  cycleProposalLead,
  cycleEventShift,
  formatDurationLabel,
  formatLeadLabel,
  formatShiftLabel,
} from './agent-core.mjs';
import { findOverlaps, buildUpdateEventBody, buildAgendaCallbackData } from './calendar-core.mjs';
import {
  addReminder,
  cancelReminder,
  updateReminder,
  listActive,
  buildReminderCancelCallbackData,
  buildReminderEditCallbackData,
} from './reminders-core.mjs';
import { normalizeSettings } from './settings-core.mjs';
import {
  loadState,
  loadSettings,
  loadAssistantPending,
  putAssistantPending,
  updateAssistantPending,
  claimAssistantPending,
  markProposalExecuted,
  updateState,
} from './kv-store.mjs';
import {
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  createContact,
  resolveAttendees,
  readCalendarRange,
} from './google.mjs';
import { tgCall, sendTo } from './telegram-client.mjs';
import { rememberAssistantQuestion } from './assistant-memory.mjs';
import { kyivDateKey } from './kyiv-time.mjs';

/** Скільки живе кнопка ✅/❌ під пропозицією, поки не стане «Застарілою». */
export const PENDING_TTL_MS = 30 * 60_000;

/**
 * Показати пропозицію під ✅/❌ (той самий цикл, що подієві stageItemEdit/
 * stageItemDelete: власний KV-ключ + buildProposalKeyboard + accept-гілка).
 */
export async function stageProposalItem(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {KvBlob} */ item,
) {
  const id = crypto.randomUUID().slice(0, 8);
  await putAssistantPending(env, { id, items: [item], createdMs: Date.now() });
  return sendTo(env, parsed)(formatProposalMessage([item]), {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, [item], {}),
  });
}

/**
 * Домалювати `base` (свіже title/whenMs/durationMin) на updateEvent/
 * deleteEvent пунктах — ОБОВʼЯЗКОВИЙ інваріант перед показом/accept: без
 * нього formatProposalMessage не мав би з чим рахувати діф, а видалення
 * показувало б голий id. Той самий крок і для LLM-пропозиції (тут), і для
 * button-staged (stageItemEdit/stageItemDelete) — обидва канали віддають
 * REST accept-loop СТРУКТУРНО ОДНАКОВІ пункти. Пункт, чий eventId уже не
 * резолвиться (подію видалено між readCalendar і пропозицією) — дропається,
 * не падає весь пакет.
 */
export async function enrichEventItems(/** @type {Env} */ env, /** @type {KvBlob[]} */ items) {
  const out = [];
  for (const item of items) {
    if (item.kind === 'settings') {
      // base = ПОТОЧНИЙ блоб — потрібен formatProposalMessage для діфу
      // «було -> стане» (той самий інваріант, що base на updateEvent).
      out.push({ ...item, base: await loadSettings(env) });
      continue;
    }

    // Гості (PR-10): event/updateEvent можуть нести "attendees" (сирі
    // імена/email від sanitizeProposal) — резолвимо в email ЩЕ ДО показу
    // пропозиції (People API), щоб текст показував «Гості: ...»/notes ще до
    // підтвердження, а не сюрпризом після ✅.
    let attendeeFields;
    if ((item.kind === 'event' || item.kind === 'updateEvent') && item.attendees?.length) {
      const { emails, notes } = await resolveAttendees(env, item.attendees);
      attendeeFields = { resolvedAttendees: emails, attendeeNotes: notes };
    }

    if (item.kind !== 'updateEvent' && item.kind !== 'deleteEvent') {
      out.push({ ...item, ...attendeeFields });
      continue;
    }
    if (item.kind === 'deleteEvent') {
      const fresh = await getCalendarEvent(env, item.eventId);
      if (!fresh) continue; // подія зникла — тихо дропаємо пункт, не весь пакет
      out.push({
        ...item,
        base: {
          title: fresh.title,
          whenMs: fresh.startMs,
          durationMin: ((fresh.endMs ?? 0) - (fresh.startMs ?? 0)) / 60_000,
        },
      });
      continue;
    }
    const fresh = await getCalendarEvent(env, item.eventId);
    if (!fresh) continue; // подія зникла — тихо дропаємо пункт, не весь пакет
    out.push({
      ...item,
      ...attendeeFields,
      base: {
        title: fresh.title,
        whenMs: fresh.startMs,
        durationMin: ((fresh.endMs ?? 0) - (fresh.startMs ?? 0)) / 60_000,
      },
    });
  }
  return out;
}

/**
 * Попередження про накладку часу (extra a, схвалено власником) для create-
 * подій і update-пунктів, що МІНЯЮТЬ час. ОДИН читальний виклик на весь
 * пакет (вікно від найранішого до найпізнішого кандидата), не по пункту —
 * дешевше й достатньо для типового пакета (≤MAX_PROPOSAL_ITEMS). Інформативно,
 * НЕ блокує пропозицію; збій читання -> тихо без попереджень (не критично).
 */
export async function computeOverlapWarnings(
  /** @type {Env} */ env,
  /** @type {KvBlob[]} */ items,
) {
  /** @type {Map<number, string[]>} */
  const warnings = new Map();
  const spans = items
    .map((/** @type {KvBlob} */ item, /** @type {number} */ index) => {
      if (item.kind === 'event' && Number.isFinite(item.whenMs)) {
        return { index, eventId: null, start: item.whenMs, dur: item.durationMin ?? 60 };
      }
      if (item.kind === 'updateEvent' && Number.isFinite(item.whenMs)) {
        return {
          index,
          eventId: item.eventId,
          start: item.whenMs,
          dur: item.durationMin ?? item.base?.durationMin ?? 60,
        };
      }
      return null;
    })
    // `!== null` замість filter(Boolean): та сама умова, але з неї виводиться
    // звуження типу, і `s.start` нижче більше не читається з можливого null.
    .filter((s) => s !== null);
  if (spans.length === 0) return warnings;

  const minMs = Math.min(...spans.map((s) => s.start));
  const maxMs = Math.max(...spans.map((s) => s.start + s.dur * 60_000));
  const events = await readCalendarRange(
    env,
    kyivDateKey(new Date(minMs)),
    kyivDateKey(new Date(maxMs)),
  );
  if (!events) return warnings;

  for (const span of spans) {
    const overlaps = findOverlaps(events, span.start, span.start + span.dur * 60_000, span.eventId);
    if (overlaps.length > 0) {
      warnings.set(
        span.index,
        overlaps.map((e) => (e.time ? `${e.title} ${e.time}` : e.title)),
      );
    }
  }
  return warnings;
}

/** Зберегти пропозицію (власний KV-ключ, ОДИН слот) + кнопки ✅/❌ підтвердження. */
export async function proposeCalendarChanges(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {any} */ rawProposal,
) {
  const sendText = sendTo(env, parsed);

  const { items: rawItems, droppedCount } = sanitizeProposal(rawProposal, Date.now());
  const items = await enrichEventItems(env, rawItems);
  if (items.length === 0) {
    return sendText(
      '🤔 Не зрозумів час жодного пункту — спробуй точніше (напр. "завтра о 15:00").',
    );
  }

  const id = crypto.randomUUID().slice(0, 8);
  // cfg = доналаштування (циклери ⏳/⏰, create-режим). null = «як є»: тривалість
  // від моделі, сповіщення за дефолтом календаря (поведінка до цієї фічі).
  const cfg = { durMin: null, leadMin: null };
  await putAssistantPending(env, { id, items, createdMs: Date.now(), cfg });

  const warnings = await computeOverlapWarnings(env, items);
  const droppedNote = droppedCount > 0 ? `\n\n⚠️ пропущено ${droppedCount} — незрозумілий час` : '';
  return sendText(formatProposalMessage(items, warnings) + droppedNote, {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, items, cfg),
  });
}

/**
 * Клавіатура ПІСЛЯ accept — Edit/Delete на кожен УСПІШНИЙ пункт (create-
 * режим), одне 🗑 (edit-режим успіх — Видалити щойно оновлену подію), або
 * нічого (delete-режим/провал). Глеїть простори ДВОХ модулів (ev: із
 * calendar-core, rc:/ru: із reminders-core) — тому тут, у worker.js, не в
 * agent-core.mjs (той жодного з них не знає, лишається чистим від Worker-
 * специфічних callback-неймспейсів).
 */
export function buildResultKeyboard(
  /** @type {KvBlob[]} */ items,
  /** @type {KvBlob[]} */ results,
) {
  const mode = proposalMode(items);

  if (mode === 'edit') {
    if (!results[0]?.ok) return { inline_keyboard: [] };
    // edit-режим — це рівно один пункт (proposalMode), тож items[0] є.
    const d = buildAgendaCallbackData('d', items[0]?.eventId);
    return d
      ? { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: d }]] }
      : { inline_keyboard: [] };
  }
  if (mode === 'delete') return { inline_keyboard: [] };

  /** @type {KvBlob[][]} */
  const rows = [];
  items.forEach((/** @type {KvBlob} */ it, /** @type {number} */ i) => {
    const r = results[i];
    if (!r?.ok || !r.id) return;
    if (it.kind === 'event') {
      const e = buildAgendaCallbackData('e', r.id);
      const d = buildAgendaCallbackData('d', r.id);
      if (e && d) {
        rows.push([
          { text: `✏️ ${i + 1}`, callback_data: e },
          { text: `🗑 ${i + 1}`, callback_data: d },
        ]);
      }
    } else if (it.kind === 'reminder') {
      const e = buildReminderEditCallbackData(r.id);
      const c = buildReminderCancelCallbackData(r.id);
      if (e && c) {
        rows.push([
          { text: `✏️ ${i + 1}`, callback_data: e },
          { text: `🗑 ${i + 1}`, callback_data: c },
        ]);
      }
    }
  });
  return { inline_keyboard: rows };
}

/**
 * Обробити pd:<action>:<id> — весь життєвий цикл пропозиції асистента
 * (`assistantPending`, ОКРЕМИЙ KV-ключ, ОДИН слот): create (a/c/d/l), edit (a/c/s/o),
 * delete (a/c). "Claim" (списати зі стану) ОДРАЗУ після перевірки, ще ДО
 * повільного циклу запису — інакше подвійний тап на ✅ (чи паралельна нова
 * пропозиція, що перезаписала слот, поки ця ще оброблялась) встигає
 * задублювати нагадування/події (createCalendarEvent — зовнішній незворотний
 * запис, не KV-стан), або стирає ЧУЖУ (новішу) пропозицію непроконтрольовано.
 *
 * ✅/❌ ЗАВЖДИ переписують повідомлення (editMessageText) — не лише тік
 * кнопки: власник має бачити результат (успіх/провал) і, для щойно
 * створених/оновлених подій-нагадувань, кнопки Edit/Delete НА МІСЦІ.
 */
export async function resolveProposalCallback(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {KvBlob} */ cb,
) {
  const pending = await loadAssistantPending(env);
  const stale = !pending || pending.id !== cb.id || Date.now() - pending.createdMs > PENDING_TTL_MS;
  if (stale) return '⚠️ Застаріла пропозиція.';
  const cfg = pending.cfg ?? { durMin: null, leadMin: null };
  const mode = proposalMode(pending.items);

  /* ── Циклери create-режиму (d=тривалість, l=lead-time) ──────────────────
     НЕ споживають пропозицію: циклимо значення, перемальовуємо клавіатуру на
     місці. Текст тут від cfg не залежить -> досить editMessageReplyMarkup. */
  if (cb.action === 'd' || cb.action === 'l') {
    if (mode !== 'create') return '⚠️ Застаріла пропозиція.';
    const updated = await updateAssistantPending(env, cb.id, (current) => {
      const currentCfg = current.cfg ?? { durMin: null, leadMin: null };
      const next =
        cb.action === 'd'
          ? { ...currentCfg, durMin: cycleProposalDuration(currentCfg.durMin) }
          : { ...currentCfg, leadMin: cycleProposalLead(currentCfg.leadMin) };
      return { ...current, cfg: next };
    });
    if (!updated.ok || !updated.pending) return '⚠️ Застаріла пропозиція.';
    const next = updated.pending.cfg ?? { durMin: null, leadMin: null };
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageReplyMarkup', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        reply_markup: buildProposalKeyboard(cb.id, updated.pending.items, next),
      });
    }
    return cb.action === 'd'
      ? `⏳ Тривалість: ${formatDurationLabel(next.durMin)}`
      : `⏰ Нагадати ${formatLeadLabel(next.leadMin)}`;
  }

  /* ── Цикл зсуву часу (s) — edit-режим АБО create-режим з ОДНИМ нагадуванням ─
     Текст ТЕЖ міняється (діф/час рахується від whenMs) -> тут editMessageText,
     не лише reply_markup. Анкер різний: edit зсуває від base.whenMs (ІСНУЮЧА
     подія), create-нагадування — від baseWhenMs (перший запропонований час;
     нової сутності ще не існує, «було» нема) — buildProposalKeyboard показує
     цей циклер лише для рівно одного пункту kind:'reminder' у create-режимі. */
  if (cb.action === 's') {
    const isCreateReminder =
      mode === 'create' && pending.items.length === 1 && pending.items[0]?.kind === 'reminder';
    if (mode !== 'edit' && !isCreateReminder) return '⚠️ Застаріла пропозиція.';
    const updated = await updateAssistantPending(env, cb.id, (current) => {
      // `pendingUpdate` відкидає інший id, а tap-и того самого slot-а не
      // змінюють його форму. Тому retry застосовує shift до свіжого item, не
      // гублячи паралельний циклер тривалості чи lead.
      const item = current.items[0];
      const anchorMs = isCreateReminder
        ? (item.baseWhenMs ?? item.whenMs ?? 0)
        : (item.base?.whenMs ?? 0);
      const nextShift = cycleEventShift(item.shiftMin ?? 0);
      const items = [
        { ...item, shiftMin: nextShift, whenMs: anchorMs + (nextShift ?? 0) * 60_000 },
      ];
      return { ...current, items };
    });
    if (!updated.ok || !updated.pending) return '⚠️ Застаріла пропозиція.';
    const nextItems = updated.pending.items;
    const nextItem = nextItems[0];
    const nextShift = nextItem?.shiftMin ?? null;
    const nextCfg = updated.pending.cfg ?? cfg;
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: formatProposalMessage(nextItems),
        parse_mode: 'HTML',
        reply_markup: buildProposalKeyboard(cb.id, nextItems, nextCfg),
      });
    }
    return `🕐 ${formatShiftLabel(nextShift)}`;
  }

  /* ── «✏️ Інше» (o) — гібрид: claim + питання + синтетична репліка ────────
     СПИСУЄ пропозицію (не циклер): «Інше» замінює подальший тап ✅/❌ на
     звичайну розмову — власник відповість вільним текстом, асистент сам
     побудує НОВУ proposeCalendarChanges(kind:'updateEvent') із eventId,
     скопійованим із позначки [id:...] (buildAssistantSystemPrompt). */
  if (cb.action === 'o') {
    if (mode !== 'edit') return '⚠️ Застаріла пропозиція.';
    const item = pending.items[0];
    const b = item.base ?? {};
    if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
      await tgCall(env, 'editMessageReplyMarkup', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
      });
    }
    if (!(await claimAssistantPending(env, cb.id))) return '⚠️ Застаріла пропозиція.';
    const { historyText, displayText } = formatEventEditQuestion(
      item.eventId,
      item.title ?? b.title,
      item.whenMs ?? b.whenMs,
    );
    await sendTo(env, parsed)(displayText);
    await rememberAssistantQuestion(env, parsed, historyText);
    return '✍️ Напиши, що змінити';
  }

  // ── ✅/❌ (a/c) — термінальні: claim ОДРАЗУ, тоді перепис повідомлення ───
  if (!(await claimAssistantPending(env, cb.id))) return '⚠️ Застаріла пропозиція.';

  // ⚠️ КЛАВІАТУРУ ЗНІМАЄМО ТУТ, а не наприкінці разом із результатом — і це
  // головна половина фіксу подвійного тапу. Доти кнопки ✅/❌ лишались живими
  // ВЕСЬ час виконання: claim, потім кілька раундтріпів до Google, і аж потім
  // перепис повідомлення. Тобто вікно для другого тапу дорівнювало тривалості
  // всієї роботи, а не мілісекундам, — а ефект незворотний (подія в календарі
  // створюється двічі). Тепер після першого тапу тапати вже нема по чому.
  //
  // Best-effort: збій edit'а НЕ має скасовувати саму роботу — повідомлення все
  // одно перепишеться нижче результатом.
  if (parsed.chatId != null && parsed.messageId != null) {
    try {
      await tgCall(env, 'editMessageReplyMarkup', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
      });
    } catch {
      /* косметика; справжній захист — markProposalExecuted нижче */
    }
  }

  if (cb.action === 'c') {
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: '❌ Скасовано.',
      });
    }
    return '❌ Скасовано';
  }

  // ⚠️ ДРУГА ПОЛОВИНА ФІКСУ — ідемпотентність на рівні ЕФЕКТУ. claim вище не
  // атомарний (KV без CAS), тож теоретично обидва тапи можуть його пройти. Цей
  // маркер ставиться ПЕРЕД будь-яким зовнішнім записом і звужує вікно до одного
  // GET->PUT. Гарантії він не дає — її дає лише Durable Object; але саме він
  // відповідає за те, що болить: другого запису в календар не буде.
  if (!(await markProposalExecuted(env, cb.id))) return '⚠️ Уже виконано.';

  const results = [];
  for (const item of pending.items) {
    if (item.kind === 'reminder') {
      const newId = crypto.randomUUID();
      const nowMs = Date.now();
      await updateState(env, (s) => ({
        ...s,
        reminders: addReminder(s.reminders, {
          id: newId,
          text: item.title,
          whenMs: item.whenMs,
          nowMs,
          chatId: parsed.chatId,
          threadId: parsed.threadId,
        }),
      }));
      results.push({ ok: true, id: newId });
    } else if (item.kind === 'event') {
      // Доналаштування: глобальний durMin/leadMin перекриває дефолти (null -> «як є»).
      const durMin = cfg.durMin ?? item.durationMin ?? 60;
      const startIso = new Date(item.whenMs).toISOString();
      const endIso = new Date(item.whenMs + durMin * 60_000).toISOString();
      const res = await createCalendarEvent(env, {
        title: item.title,
        startIso,
        endIso,
        reminderMinutes: cfg.leadMin ?? undefined,
        location: item.location,
        attendees: item.resolvedAttendees, // РЕЗОЛЬВЛЕНІ email (enrichEventItems), не сирі імена
      });
      results.push(res.ok ? { ok: true, id: res.id } : { ok: false });
    } else if (item.kind === 'updateEvent') {
      // Поля, які циклер/"Інше" НЕ чіпали (undefined) -> беремо з base
      // (свіжопрочитана подія при стейджингу) — часткове оновлення.
      const b = item.base ?? {};
      const title = item.title ?? b.title;
      const whenMs = item.whenMs ?? b.whenMs;
      const durationMin = item.durationMin ?? b.durationMin ?? 60;
      const startIso = new Date(whenMs).toISOString();
      const endIso = new Date(whenMs + durationMin * 60_000).toISOString();
      const res = await updateCalendarEvent(env, {
        eventId: item.eventId,
        patch: buildUpdateEventBody({
          title,
          startIso,
          endIso,
          location: item.location,
          attendees: item.resolvedAttendees,
        }),
      });
      results.push(res.ok ? { ok: true, id: item.eventId } : { ok: false });
    } else if (item.kind === 'deleteEvent') {
      const res = await deleteCalendarEvent(env, { eventId: item.eventId });
      results.push(res.ok ? { ok: true } : { ok: false });
    } else if (item.kind === 'deleteReminder' || item.kind === 'updateReminder') {
      /* Мутація нагадування ПІСЛЯ ✅ (S2). Читаємо стан ЗАНОВО (між пропозицією
         і тапом могло минути до PENDING_TTL_MS — нагадування могло спрацювати,
         бути скасованим кнопкою чи зміненим). Тому спершу перевіряємо, що воно
         ще активне: примітиви cancelReminder/updateReminder на невідомий id —
         тихий no-op, і без цієї перевірки власник бачив би «готово» там, де
         нічого не сталось. */
      const fresh = await loadState(env);
      const target = listActive(fresh.reminders).find((r) => r.id === item.reminderId);
      if (!target) {
        results.push({ ok: false });
      } else {
        await updateState(env, (s) => ({
          ...s,
          reminders:
            item.kind === 'deleteReminder'
              ? cancelReminder(s.reminders, item.reminderId)
              : updateReminder(s.reminders, item.reminderId, {
                  ...(item.title ? { text: item.title } : {}),
                  ...(Number.isFinite(item.whenMs) ? { whenMs: item.whenMs } : {}),
                }),
        }));
        results.push({ ok: true });
      }
    } else if (item.kind === 'settings') {
      // Повторна нормалізація тут НАВМИСНО (item.settings уже нормалізований у
      // sanitizeProposal) — той самий "не довіряй нічому, що пролежало в KV/
      // пройшло через мережу" рефлекс, що й решта accept-циклу.
      await env.BRIEFING.put('settings', JSON.stringify(normalizeSettings(item.settings)));
      results.push({ ok: true });
    } else if (item.kind === 'contact') {
      const res = await createContact(env, { name: item.title, email: item.email });
      results.push(res.ok ? { ok: true } : { ok: false });
    } else {
      results.push({ ok: false });
    }
  }

  if (parsed.chatId != null && parsed.messageId != null) {
    const resultKeyboard = buildResultKeyboard(pending.items, results);
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: formatProposalResult(pending.items, results),
      parse_mode: 'HTML',
      // reply_markup лише коли є що показати — Telegram не любить порожній inline_keyboard.
      ...(resultKeyboard.inline_keyboard.length ? { reply_markup: resultKeyboard } : {}),
    });
  }

  if (mode === 'delete') return results[0]?.ok ? '🗑 Видалено' : '⚠️ Не вдалось видалити';
  if (mode === 'edit') return results[0]?.ok ? '✅ Оновлено' : '⚠️ Не вдалось оновити';
  if (mode === 'reminderDelete') {
    return results[0]?.ok ? '🗑 Скасовано нагадування' : '⚠️ Не вдалось скасувати';
  }
  if (mode === 'reminderEdit') {
    return results[0]?.ok ? '✅ Оновлено нагадування' : '⚠️ Не вдалось оновити';
  }
  if (mode === 'settings') return results[0]?.ok ? '⚙️ Застосовано' : '⚠️ Не вдалось застосувати';
  if (mode === 'contact') return results[0]?.ok ? '👤 Збережено' : '⚠️ Не вдалось зберегти';
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  return fail > 0 ? `✅ Додано ${ok}, ⚠️ не вдалось ${fail}` : `✅ Додано ${ok}`;
}

/** Стейджити РЕДАГУВАННЯ існуючої події (`ev:e:<id>` — з /agenda чи
 *  пост-accept кнопки): читає СВІЖУ подію (список/попередній accept міг бути
 *  застарілим), будує single-item updateEvent-пропозицію (shiftMin=0 -> «як
 *  заплановано») і шле тим самим шляхом, що звичайна пропозиція (той самий
 *  keyboard/accept-цикл, що LLM-шлях, resolveProposalCallback). */
export async function stageItemEdit(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ eventId,
) {
  const fresh = await getCalendarEvent(env, eventId);
  if (!fresh) return '🤔 Цю подію вже не знайти — можливо, видалено.';

  const base = {
    title: fresh.title,
    whenMs: fresh.startMs,
    durationMin:
      Number.isFinite(fresh.endMs) && Number.isFinite(fresh.startMs)
        ? ((fresh.endMs ?? 0) - (fresh.startMs ?? 0)) / 60_000
        : 60,
  };
  const item = { kind: 'updateEvent', eventId, shiftMin: 0, whenMs: base.whenMs, base };
  const id = crypto.randomUUID().slice(0, 8);
  await putAssistantPending(env, { id, items: [item], createdMs: Date.now() });
  await sendTo(env, parsed)(formatProposalMessage([item]), {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, [item], {}),
  });
  return '✏️ Онови час чи напиши, що змінити';
}

/** Стейджити ВИДАЛЕННЯ існуючої події (`ev:d:<id>`) — той самий підтверджувальний
 *  цикл, що create/update (✅/❌, delete-режим клавіатури — лише Так/Ні). */
export async function stageItemDelete(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ eventId,
) {
  const fresh = await getCalendarEvent(env, eventId);
  if (!fresh) return '🤔 Цю подію вже не знайти — можливо, видалено.';

  const base = { title: fresh.title, whenMs: fresh.startMs };
  const item = { kind: 'deleteEvent', eventId, base };
  const id = crypto.randomUUID().slice(0, 8);
  await putAssistantPending(env, { id, items: [item], createdMs: Date.now() });
  await sendTo(env, parsed)(formatProposalMessage([item]), {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, [item], {}),
  });
  return '🗑 Підтверди видалення';
}
