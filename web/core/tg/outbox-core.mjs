// Чиста логіка outbox (07-schema §1 `outbox`, 01-architecture §2.1 `tg`):
// розбиття довгих текстів, бекоф ретраїв, вибір прострочених. Платформна
// частина (D1, fetch у Telegram, sleep) - у сусідньому outbox.mjs.

/** Стеля Telegram на текст одного повідомлення. */
export const TG_TEXT_LIMIT = 4096;

/** Пауза між відправками при драйні - стеля Telegram 1/с на чат з запасом. */
export const THROTTLE_MS = 1_050;

/** Рядів за один прохід драйну: < 20 гарантує стелю 20/хв на чат при
 *  sweeper-каденції раз на 5 хв; ad-hoc драйни ділять ряди через claim. */
export const DRAIN_BATCH_LIMIT = 18;

/** Після стількох невдач ряд стає failed - вічний ретрай ховав би поломку. */
export const MAX_ATTEMPTS = 8;

/** Завислий claim (ізолят умер посеред відправки) повертається в чергу. */
export const STUCK_SENDING_MS = 2 * 60_000;

/**
 * Розбити текст на частини ≤ limit, ріжучи по межах абзаців/рядків/слів -
 * приймання етапу: повідомлення понад 4096 приходить кількома частинами,
 * а не 400 від Telegram.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitMessage(text, limit = TG_TEXT_LIMIT) {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];
  const parts = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Найпізніша природна межа у вікні; зовсім без межі - жорсткий зріз.
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    /** @type {number} */
    let at = cut > limit / 2 ? cut : limit;
    // Жорсткий зріз не сміє розполовинити сурогатну пару (емодзі): самотній
    // сурогат Telegram відкидає 400-кою на обидві частини.
    if (at === limit && /[\uD800-\uDBFF]/.test(rest[at - 1] ?? '')) at -= 1;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Коли пробувати наступного разу. 429 несе retry_after - віримо йому;
 * інші збої - експонента від 30 с до 30 хв (транзієнтне лікується швидко,
 * стійке не молотить Telegram щосекунди).
 * @param {number} nowMs
 * @param {number} attempts вже зроблених спроб (після інкременту)
 * @param {number} [retryAfterSec] з відповіді 429
 */
export function nextAttemptAt(nowMs, attempts, retryAfterSec) {
  if (retryAfterSec != null && Number.isFinite(retryAfterSec)) {
    return nowMs + Math.max(1, retryAfterSec) * 1_000;
  }
  const delay = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return nowMs + delay;
}

/**
 * Помилка парсингу розмітки - єдиний збій, який лікується ПОВТОРОМ БЕЗ
 * parse_mode (Rich Message із fallback на звичайне): краще повідомлення без
 * жирного, ніж жодного.
 * @param {number} status
 * @param {string} description
 */
export function isParseEntitiesError(status, description) {
  return status === 400 && /parse entities/i.test(description);
}

/**
 * «Текст той самий» - Telegram відповідає 400 на editMessageText, коли новий
 * текст дослівно дорівнює поточному. Для нас це УСПІХ, а не збій: фінал
 * заміняє чернетку статусу, і якщо останній партіал уже був повною
 * відповіддю, редагувати нічого. Без цієї гілки ряд ішов би в ретраї, а
 * потім у failed - на повністю доставленій відповіді.
 * @param {number} status
 * @param {string} description
 */
export function isNotModifiedError(status, description) {
  return status === 400 && /message is not modified/i.test(description);
}

/**
 * Чернетки, яку мали відредагувати, більше немає (власник стер статусник або
 * його не можна редагувати). Для ВІДПОВІДІ це не кінець: викликач шле її
 * новим повідомленням, інакше відповідь зникла б разом із чернеткою.
 * @param {number} status
 * @param {string} description
 */
export function isEditTargetGone(status, description) {
  return status === 400 && /message to edit not found|message can't be edited/i.test(description);
}
