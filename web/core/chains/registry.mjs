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
  price: 'PRICE_TRACK',
  trip: 'TRIP_CHAIN',
});

/** «скасуй столик», «відміни» - це для мозку (chain.cancel), не відповідь ланцюгу. */
export const CANCEL_TEXT_RE = /скасу|відмін|відмов|не треба|cancel/i;

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

/** Стани плану дня, що годуються текстом. */
const DAY_PLAN_TEXT_AWAITS = ['intent', 'answer'];
/** Стани TableChain, у яких власник відповідає текстом безумовно (назва/номер, час, імена). */
export const TABLE_TEXT_AWAITS = ['venue_text', 'phone', 'time', 'invitees'];
/** Стани TableChain з кнопками, де текст теж приймається, але лише певної форми. */
const TABLE_BUTTON_AWAITS = ['venue', 'contact', 'next'];
/** Стани TripChain: 'spent' - будь-який текст (сума + як пройшло), 'checklist' - лише сума. */
const TRIP_TEXT_AWAITS = ['spent'];
const TRIP_BUTTON_AWAITS = ['checklist'];
/**
 * Сума без іншого тексту: «3500», «3 500 грн», «1 200,50». Класи НЕ
 * перекриваються і довжина обмежена - інакше рядок «цифра + сотні пробілів»
 * дає поліноміальний бектрекінг (заміряно: 3200 пробілів = 7 с CPU).
 */
const MONEY_ONLY_RE = /^\d[\d ]{0,20}(?:[.,]\d{1,2})?(?: ?(?:грн|uah|₴|eur|€|usd|\$))?$/i;
/** Стеля довжини для тесту MONEY_ONLY_RE (сума довшою не буває). */
const MONEY_MAX_LEN = 32;

/**
 * Ланцюг, що чекає слова власника ТЕКСТОМ (не лише кнопкою) у цьому треді:
 * той, що спитав останнім (awaiting_since), серед станів, які його kind уміє
 * прочитати з тексту.
 * @param {Env} env @param {string | null} [threadKey] - тред повідомлення ('dm' або id теми); null - будь-який
 * @returns {Promise<{ id: string, kind: string, awaiting: string } | null>}
 */
export async function findAwaitingChain(env, threadKey = null) {
  const awaits = [
    ...DAY_PLAN_TEXT_AWAITS,
    ...TABLE_TEXT_AWAITS,
    ...TABLE_BUTTON_AWAITS,
    ...TRIP_TEXT_AWAITS,
    ...TRIP_BUTTON_AWAITS,
  ];
  const { results } = await db(env)
    .prepare(
      `SELECT id, kind, json_extract(state_json, '$.awaiting') AS awaiting,
              json_extract(state_json, '$.thread_id') AS thread_id
       FROM chains
       WHERE status = 'waiting' AND json_extract(state_json, '$.awaiting') IN (${awaits.map(() => '?').join(', ')})
       ORDER BY COALESCE(json_extract(state_json, '$.awaiting_since'), updated_at) DESC LIMIT 10`,
    )
    .bind(...awaits)
    .all();
  for (const r of results ?? []) {
    const kind = String(r.kind);
    const awaiting = String(r.awaiting);
    // Ланцюг столика памʼятає тред старту; план дня живе в темі «Асистент».
    if (threadKey != null && r.thread_id != null && String(r.thread_id) !== threadKey) continue;
    if (kind === 'day-plan' && !DAY_PLAN_TEXT_AWAITS.includes(awaiting)) continue;
    if (kind === 'table' && ![...TABLE_TEXT_AWAITS, ...TABLE_BUTTON_AWAITS].includes(awaiting)) {
      continue;
    }
    if (kind === 'trip' && ![...TRIP_TEXT_AWAITS, ...TRIP_BUTTON_AWAITS].includes(awaiting)) {
      continue;
    }
    if (kind !== 'day-plan' && kind !== 'table' && kind !== 'trip') continue;
    return { id: String(r.id), kind, awaiting };
  }
  return null;
}

/** «на 19:00», «о 19», «19.30» - лише годинник, без іншого тексту. @param {string} text */
export function looksLikeClock(text) {
  return /^\s*(?:о|на)?\s*\d{1,2}(?:[:.]\d{2})?\s*$/i.test(text);
}

/** Телефон (≥ 9 цифр) - для станів, де ланцюг просив номер. @param {string} text */
function looksLikePhone(text) {
  return (text.match(/\d/g) ?? []).length >= 9 && /^[\d\s()+-]+$/.test(text.trim());
}

/**
 * Текст власника → подія для ланцюга, що на нього чекає; null - цей текст
 * ланцюгу не годиться (кнопки або інший зміст), і він іде в мозок. Слова
 * скасування завжди йдуть у мозок: там chain.cancel, а ланцюг сприйняв би їх
 * як назву закладу.
 * @param {string} kind @param {string} awaiting @param {string} text
 * @returns {{ type: string, payload: Record<string, unknown> } | null}
 */
export function textEvent(kind, awaiting, text) {
  if (kind === 'day-plan') {
    return DAY_PLAN_TEXT_AWAITS.includes(awaiting) ? { type: awaiting, payload: { text } } : null;
  }
  if (kind === 'trip') {
    if (CANCEL_TEXT_RE.test(text)) return null;
    const trip = { type: 'trip', payload: { action: 'text', text } };
    if (TRIP_TEXT_AWAITS.includes(awaiting)) return trip;
    // Стан 'dates' (після «Які нові дати?») - не наш: дату розбирає мозок і
    // повертає її через chain.start(trip_id), інакше «12.09» стало б сумою.
    if (!TRIP_BUTTON_AWAITS.includes(awaiting)) return null;
    // Між блоками ланцюг бере лише суму (ціна квитка); решта - розмова.
    const money = text.trim().replace(/\u00a0/g, ' ');
    return money.length <= MONEY_MAX_LEN && MONEY_ONLY_RE.test(money) ? trip : null;
  }
  if (kind !== 'table' || CANCEL_TEXT_RE.test(text)) return null;
  const table = { type: 'table', payload: { action: 'text', text } };
  if (TABLE_TEXT_AWAITS.includes(awaiting)) return table;
  // Кнопкові стани: у списку закладів - коротка назва або номер («напиши
  // назву» з нагадування), після контакту - лише номер, після «Подзвонив» -
  // лише годинник («напиши «на 19:00»»). Решта - розмова з асистентом.
  if (awaiting === 'venue') {
    return looksLikePhone(text) || (text.length <= 40 && !text.includes('?')) ? table : null;
  }
  if (awaiting === 'contact') return looksLikePhone(text) ? table : null;
  if (awaiting === 'next') return looksLikeClock(text) ? table : null;
  return null;
}

/**
 * Кнопка ланцюга → подія. Мапа choice → {type, payload} - єдине місце, де
 * назви кнопок зустрічаються з типами подій машин станів. `keep` - не знімати
 * клавіатуру повідомлення (кілька пунктів в одному блоці).
 * @param {string} kind @param {string} choice
 * @returns {{ type: string, payload: Record<string, unknown>, keep?: boolean } | null}
 */
export function choiceEvent(kind, choice) {
  if (kind === 'day-plan') return dayPlanChoiceEvent(choice);
  if (kind === 'table') return tableChoiceEvent(choice);
  if (kind === 'trip') return tripChoiceEvent(choice);
  // Відстеження ціни (PR-3): єдина кнопка - «Стоп».
  if (kind === 'price' && choice === 'stop') return { type: 'price', payload: { action: 'stop' } };
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

/**
 * Поїздка (S-5-5…S-5-10): d<block>_<idx> - ✅ пункт чекліста; newdate -
 * власник хоче інші дати (нові дати ланцюг не парсить: питає текстом, а
 * дати кладе мозок через chain.start з trip_id); cancel - скасувати.
 * @param {string} choice
 * @returns {{ type: string, payload: Record<string, unknown>, keep?: boolean } | null}
 */
export function tripChoiceEvent(choice) {
  const trip = (/** @type {Record<string, unknown>} */ payload) => ({ type: 'trip', payload });
  if (choice === 'cancel') return trip({ action: 'cancel' });
  if (choice === 'newdate') return trip({ action: 'ask-date' });
  // `keep` - клавіатуру блоку не знімати: у блоці кілька пунктів, і після
  // першого ✅ решта кнопок мусить лишитись (на відміну від вибору столика).
  const d = choice.match(/^d(t30|t7|t1|road)_(\d{1,2})$/);
  if (d) return { ...trip({ action: 'done', item: `${d[1]}:${d[2]}` }), keep: true };
  return null;
}
