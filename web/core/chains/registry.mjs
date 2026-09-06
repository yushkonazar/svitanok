// Реєстр ланцюгів (07 §6, 01 §3.8, етап 5 PR-2): kind рядка `chains` →
// привʼязка Workflow і переклад кнопок `c:<chainId>:<choice>` (07 §9) та
// тексту власника в подію машини станів. До етапу 5 єдиним «зовнішнім»
// ланцюгом був план дня, і prerouter/router знали лише його; тепер kind
// читається з рядка, а решта - таблиця тут. Модулі ланцюгів сюди НЕ
// імпортуються (тільки чисті мапи choice → подія), тож циклу з policy немає.

/** kind → імʼя привʼязки Workflow у wrangler.jsonc. */
export const CHAIN_BINDINGS = /** @type {const} */ ({
  'day-plan': 'DAY_PLAN',
  idea: 'IDEA_ANALYSIS',
  table: 'TABLE_CHAIN',
});

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * kind ланцюга за id (null - рядка немає).
 * @param {Env} env @param {string} chainId
 */
export async function readChainKind(env, chainId) {
  const row = /** @type {{ kind: string } | null} */ (
    await db(env).prepare('SELECT kind FROM chains WHERE id = ?').bind(chainId).first()
  );
  return row ? String(row.kind) : null;
}

/**
 * Подія в інстанс Workflow за id ланцюга: привʼязку вибирає kind рядка.
 * Кидає, коли рядка/привʼязки/інстанса немає - викликачі логують і
 * відповідають власнику чесно.
 * @param {Env} env @param {string} chainId @param {string} type @param {Record<string, unknown>} payload
 */
export async function sendChainEvent(env, chainId, type, payload) {
  const kind = await readChainKind(env, chainId);
  if (!kind) throw new Error(`ланцюга ${chainId} немає`);
  const name = CHAIN_BINDINGS[/** @type {keyof typeof CHAIN_BINDINGS} */ (kind)];
  const binding = name ? /** @type {any} */ (env)[name] : null;
  if (!binding) throw new Error(`привʼязки Workflow для ланцюга kind=${kind} немає`);
  const instance = await binding.get(chainId);
  await instance.sendEvent({ type, payload });
  return true;
}

/**
 * Ланцюг, що чекає слова власника ТЕКСТОМ (не лише кнопкою): найсвіжіший
 * waiting із awaiting, який його kind уміє прочитати з тексту.
 * @param {Env} env
 * @returns {Promise<{ id: string, kind: string, awaiting: string } | null>}
 */
export async function findAwaitingChain(env) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, kind, json_extract(state_json, '$.awaiting') AS awaiting FROM chains
       WHERE status = 'waiting' AND json_extract(state_json, '$.awaiting') IS NOT NULL
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .bind()
    .all();
  for (const r of results ?? []) {
    const kind = String(r.kind);
    const awaiting = String(r.awaiting);
    if (textEvent(kind, awaiting, '') !== null) return { id: String(r.id), kind, awaiting };
  }
  return null;
}

/**
 * Текст власника → подія для ланцюга, що на нього чекає; null - цей стан
 * текстом не годується (кнопки або нічого), і текст іде в мозок.
 * @param {string} kind @param {string} awaiting @param {string} text
 * @returns {{ type: string, payload: Record<string, unknown> } | null}
 */
export function textEvent(kind, awaiting, text) {
  if (kind === 'day-plan') {
    return awaiting === 'intent' || awaiting === 'answer'
      ? { type: awaiting, payload: { text } }
      : null;
  }
  if (kind === 'table') {
    return TABLE_TEXT_AWAITS.includes(awaiting)
      ? { type: 'table', payload: { action: 'text', text } }
      : null;
  }
  return null;
}

/** Стани TableChain, у яких власник відповідає текстом (назва/номер, час, імена). */
export const TABLE_TEXT_AWAITS = ['venue_text', 'phone', 'time', 'invitees'];

/**
 * Кнопка ланцюга → подія. Мапа choice → {type, payload} - єдине місце, де
 * назви кнопок зустрічаються з типами подій машин станів.
 * @param {string} kind @param {string} choice
 * @returns {{ type: string, payload: Record<string, unknown> } | null}
 */
export function choiceEvent(kind, choice) {
  if (kind === 'day-plan') return dayPlanChoiceEvent(choice);
  if (kind === 'table') return tableChoiceEvent(choice);
  return null;
}

/** План дня (етап 3 PR-8). @param {string} choice */
export function dayPlanChoiceEvent(choice) {
  if (choice === 'none' || choice === 'skip') return { type: 'intent', payload: { choice } };
  if (choice === 'accept' || choice === 'edit' || choice === 'calendar') {
    return { type: 'accept', payload: { choice } };
  }
  if (choice === 'carry_all' || choice === 'carry_none')
    return { type: 'carry', payload: { choice } };
  const a = choice.match(/^a(\d)_(\d)$/);
  if (a) return { type: 'answer', payload: { item: Number(a[1]), option: Number(a[2]) } };
  return null;
}

/**
 * Столик (S-1-5…S-1-12): v0..v7/vother - заклад; called/later/phone - після
 * контакту; route/leave/invite/fav/done - після «Подзвонив»; mwalk/mtransit/
 * mcar - спосіб; r1..r5/rskip - оцінка; cancel - будь-коли.
 * @param {string} choice
 */
export function tableChoiceEvent(choice) {
  const table = (/** @type {Record<string, unknown>} */ payload) => ({ type: 'table', payload });
  if (choice === 'cancel') return table({ action: 'cancel' });
  const v = choice.match(/^v(\d)$/);
  if (v) return table({ action: 'venue', index: Number(v[1]) });
  if (choice === 'vother') return table({ action: 'venue', other: true });
  if (choice === 'called' || choice === 'later' || choice === 'phone')
    return table({ action: choice });
  if (['route', 'leave', 'invite', 'fav', 'done'].includes(choice)) {
    return table({ action: 'next', choice });
  }
  const m = choice.match(/^m(walk|transit|car)$/);
  if (m) return table({ action: 'mode', mode: m[1] });
  const r = choice.match(/^r([1-5])$/);
  if (r) return table({ action: 'rating', stars: Number(r[1]) });
  if (choice === 'rskip') return table({ action: 'rating', stars: null });
  return null;
}
