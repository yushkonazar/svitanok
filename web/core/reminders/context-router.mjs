import { kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { isPrimaryOwner } from '../../auth-core.mjs';
import {
  parseContextIntent,
  currentWorkContext,
  ensureWorkContext,
  createContextReminder,
  queueContextDelivery,
  contextReminderCard,
  renderContextDelivery,
  listContextReminders,
  changeContextReminder,
  editContextReminder,
} from './context-store.mjs';

/** @param {Env} env @param {any} target @param {Record<string,unknown>} card @param {number} nowMs @param {boolean} [edit] */
async function show(env, target, card, nowMs, edit = false) {
  await enqueueOutbox(
    env,
    {
      chatId: target.chatId,
      threadId: target.threadId,
      kind: edit && target.messageId != null ? 'edit' : 'send',
      payload: {
        ...card,
        ...(edit && target.messageId != null ? { message_id: target.messageId } : {}),
      },
    },
    nowMs,
  );
}
/** @param {any} context @param {number} nowMs */
function finishQuestion(context, nowMs) {
  const token = nowMs.toString(36);
  return {
    text: 'Роботу завершив? Тоді покажу справи перед дорогою додому.',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Так, завершив', callback_data: `er:w:${context.id}:${token}:yes` },
          { text: 'Ні, ще працюю', callback_data: `er:w:${context.id}:${token}:no` },
        ],
      ],
    },
  };
}

/** @param {Env} env @param {any} parsed @param {string} text @param {number} nowMs */
export async function routeContextReminder(env, parsed, text, nowMs) {
  const intent = parseContextIntent(text, nowMs);
  if (!intent || !isPrimaryOwner(env, parsed.fromId)) return false;
  try {
    if (!env.DB) throw new Error('missing-database');
    if (intent.kind === 'recurring' || intent.kind === 'invalid') {
      await show(
        env,
        parsed,
        {
          text:
            intent.kind === 'recurring'
              ? 'Поки можу нагадати після конкретної зміни. Щоденне повторення ще не підтримується.'
              : 'Напиши одну коротку справу: «Нагадай після роботи заїхати в Сільпо».',
        },
        nowMs,
      );
    } else if (intent.kind === 'create') {
      if (parsed.messageId == null) throw new Error('missing-source-message');
      const row = await createContextReminder(
        env,
        parsed,
        { text: String(intent.text), date: intent.date },
        JSON.stringify([parsed.chatId, parsed.threadId ?? '', parsed.messageId]),
        nowMs,
      );
      // A creator racing finish must flush its own newly committed pending row.
      await queueContextDelivery(env, row.context_id, nowMs);
    } else if (intent.kind === 'edit') {
      const row = await editContextReminder(env, parsed, String(intent.text), nowMs);
      await show(
        env,
        parsed,
        row
          ? contextReminderCard(row, row)
          : { text: 'Спершу натисни «Змінити» під потрібною справою.' },
        nowMs,
      );
    } else if (intent.kind === 'start') {
      const date = kyivDateKey(new Date(nowMs));
      const active = await currentWorkContext(env, parsed, nowMs);
      const context =
        active?.work_date === date && !active.finished_at
          ? active
          : await ensureWorkContext(env, parsed, date, nowMs);
      if (!context.finished_at) {
        await env.DB.prepare(
          'UPDATE work_contexts SET started_at=COALESCE(started_at,?),activated_at=?,confirmation_at=NULL WHERE id=?',
        )
          .bind(new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), context.id)
          .run();
      } else {
        await ensureWorkContext(
          env,
          parsed,
          kyivDateKey(new Date(nowMs)),
          nowMs,
          `start:${parsed.messageId}`,
        );
      }
      await show(
        env,
        parsed,
        { text: 'Початок роботи відмітив. Справи «після роботи» покажу, коли завершиш.' },
        nowMs,
      );
    } else {
      let context = await currentWorkContext(env, parsed, nowMs);
      context ??= await ensureWorkContext(env, parsed, kyivDateKey(new Date(nowMs)), nowMs);
      if (context.finished_at) {
        await show(
          env,
          parsed,
          { text: 'Завершення роботи вже відмічено. Справи залишились у «Нагадуваннях».' },
          nowMs,
        );
      } else {
        const work =
          intent.kind === 'home'
            ? await env.DB.prepare(
                "SELECT i.id FROM plan_items i JOIN day_plans p ON p.date=i.date WHERE i.date=? AND p.status='accepted' AND i.role='work' AND i.status NOT IN ('skipped','carried') LIMIT 1",
              )
                .bind(context.work_date)
                .first()
            : null;
        if (intent.kind === 'home' && !context.started_at && !work) {
          await env.DB.prepare('UPDATE work_contexts SET confirmation_at=? WHERE id=?')
            .bind(new Date(nowMs).toISOString(), context.id)
            .run();
          await show(env, parsed, finishQuestion(context, nowMs), nowMs);
        } else {
          const delivery = await queueContextDelivery(env, context.id, nowMs, true);
          if (!delivery.queued)
            await show(
              env,
              parsed,
              { text: 'Роботу завершено. Справ «після роботи» немає.' },
              nowMs,
            );
        }
      }
    }
    await drainOutbox(env, { nowMs }).catch(() => {});
  } catch (error) {
    console.error(
      'context reminders: local operation failed',
      String(error).includes('context-full') ? 'capacity' : 'storage',
    );
    await show(
      env,
      parsed,
      {
        text: String(error).includes('context-full')
          ? 'У цій зміні вже 20 справ. Заверши або прибери частину перед додаванням нової.'
          : 'Не вдалося зберегти зміну. Спробуй ще раз — успіх не підтверджую.',
      },
      nowMs,
    ).catch(() => {});
    await drainOutbox(env, { nowMs }).catch(() => {});
  }
  return true;
}

/** @param {Env} env @param {any} parsed @param {number} nowMs @param {boolean} [drain] */
export async function contextReminderCallback(env, parsed, nowMs, drain = true) {
  const data = String(parsed.data ?? '');
  if (!data.startsWith('er:')) return null;
  if (!isPrimaryOwner(env, parsed.fromId) || parsed.chatId == null) return 'Це кнопка власника.';
  const item = /^er:i:([a-f0-9]{32}):(edit|cancel|now|next)$/.exec(data);
  const group = /^er:g:([a-f0-9]{32}):(\d{1,2}):(done|later|next|cancel)$/.exec(data);
  const finish = /^er:w:([a-f0-9]{32}):([a-z0-9]{6,12}):(yes|no)$/.exec(data);
  const explicitFinish = /^er:f:([a-f0-9]{32})$/.exec(data);
  if (!item && !group && !finish && !explicitFinish) return 'Ця кнопка вже неактуальна.';
  try {
    if (!env.DB) throw new Error('missing-database');
    if (explicitFinish) {
      const context = await currentWorkContext(env, parsed, nowMs);
      if (!context || context.id !== explicitFinish[1] || context.finished_at)
        return 'Це не поточна зміна або її вже завершено.';
      const delivery = await queueContextDelivery(
        env,
        context.id,
        nowMs,
        true,
        parsed.messageId ?? null,
      );
      if (!delivery.queued)
        await show(
          env,
          parsed,
          {
            text: 'Роботу завершено. Справ «після роботи» немає.',
            reply_markup: { inline_keyboard: [] },
          },
          nowMs,
          true,
        );
    } else if (finish) {
      const askedMs = Number.parseInt(String(finish[2]), 36);
      if (!Number.isFinite(askedMs) || nowMs < askedMs || nowMs - askedMs > 10 * 60_000)
        return 'Це уточнення вже минуло. Напиши «їду додому» ще раз.';
      const changed = await env.DB.prepare(
        `UPDATE work_contexts SET confirmation_at=NULL,
        finished_at=CASE WHEN ?='yes' THEN COALESCE(finished_at,?) ELSE finished_at END
        WHERE id=? AND chat_id=? AND thread_id=? AND confirmation_at=? AND finished_at IS NULL`,
      )
        .bind(
          finish[3],
          new Date(nowMs).toISOString(),
          finish[1],
          String(parsed.chatId),
          String(parsed.threadId ?? ''),
          new Date(askedMs).toISOString(),
        )
        .run();
      if (!changed.meta?.changes) return 'Це вже вирішено.';
      const delivery =
        finish[3] === 'yes'
          ? await queueContextDelivery(
              env,
              String(finish[1]),
              nowMs,
              false,
              parsed.messageId ?? null,
            )
          : { queued: false };
      if (!delivery.queued)
        await show(
          env,
          parsed,
          {
            text:
              finish[3] === 'no'
                ? 'Добре, справи залишаться до завершення роботи.'
                : delivery.queued
                  ? 'Роботу завершено. Справи — нижче.'
                  : 'Роботу завершено. Справ «після роботи» немає.',
            reply_markup: { inline_keyboard: [] },
          },
          nowMs,
          true,
        );
    } else {
      let id = item?.[1];
      if (group) {
        const delivery = /** @type {any} */ (
          await env.DB.prepare(
            `SELECT d.snapshot_json FROM context_deliveries d
          JOIN work_contexts c ON c.id=d.context_id WHERE d.id=? AND c.chat_id=? AND c.thread_id=?`,
          )
            .bind(group[1], String(parsed.chatId), String(parsed.threadId ?? ''))
            .first()
        );
        id = delivery ? JSON.parse(delivery.snapshot_json)[Number(group[2])]?.id : null;
      }
      if (!id) return 'Це вже вирішено.';
      const action = item?.[2] ?? String(group?.[3]);
      const row = await changeContextReminder(env, parsed, id, action, nowMs, group?.[1]);
      if (!row) return 'Це вже вирішено.';
      const card =
        action === 'edit'
          ? {
              text: 'Напиши «Нова справа: …». Зміню лише цю справу; інші запити не завадять.',
              reply_markup: { inline_keyboard: [] },
            }
          : group
            ? await renderContextDelivery(env, String(group[1]))
            : action === 'now'
              ? {
                  text: 'Справу додано до поточних нагадувань.',
                  reply_markup: { inline_keyboard: [] },
                }
              : contextReminderCard(row, row);
      await show(env, parsed, card, nowMs, true);
    }
    if (drain) await drainOutbox(env, { nowMs }).catch(() => {});
    return 'Готово.';
  } catch (error) {
    if (String(error).includes('context-full'))
      return 'У завтрашній зміні вже 20 справ. Спершу звільни місце.';
    return 'Не вдалося оновити. Перевір «Нагадування» перед повтором.';
  }
}

/** @param {Env} env @param {any} target @param {number} nowMs */
export async function showContextReminders(env, target, nowMs) {
  const rows = await listContextReminders(env, target);
  if (!rows.length) return;
  const groupIds = [...new Set(rows.filter((r) => r.delivery_id).map((r) => r.delivery_id))];
  for (const id of groupIds) await show(env, target, await renderContextDelivery(env, id), nowMs);
  for (const row of rows.filter((r) => !r.delivery_id))
    await show(env, target, contextReminderCard(row, row), nowMs);
  await drainOutbox(env, { nowMs }).catch(() => {});
}
