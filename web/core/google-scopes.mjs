// Скоупи Google, потрібні ядру (05-ops §2, етап 7 PR-1) - і звірка того, що
// власник справді видав, із тим, що ядро використовує.
//
// ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ І ЧОМУ СПИСОК ТУТ. Скоуп у токені - це права, які
// має ядро. Їх дві помилки, і дзеркальні: БРАК скоупа ламає одну можливість
// (Tasks мовчки віддає 403), а ЗАЙВИЙ скоуп мовчки розширює наслідки будь-
// якого багу чи інʼєкції - `gmail.send` у токені означає, що «надіслати лист
// неможливо» перестає бути правдою про систему й стає правдою лише про
// поточний код. Тому перевіряються обидві сторони, і список живе в одному
// місці: його ж читає scripts/google-auth.mjs, який токен і видає, тож
// «видане» і «потрібне» не можуть розійтися через людську копію.
//
// Без мережі й привʼязок: чисті функції, вичерпно тестуються.

/**
 * Рівно ті скоупи, якими користується ядро - і НАЙВУЖЧІ з можливих. Кожен
 * рядок - із конкретного виклику, не «про запас»:
 *   calendar.events - readCalendarRange / create / patch / delete (google.mjs);
 *                     повний `auth/calendar` дає ще й керування списками
 *                     календарів, чого ядро не робить ніде
 *   gmail.readonly  - mail.search / mail.read + задача mail-triage
 *   contacts        - searchContact (читання) і createContact (запис, PR-13)
 *   drive.file      - бекапи, документи працівників, експорт (лише свої файли)
 *   drive.readonly  - один ЯВНО названий файл для вузької бази знань; код не
 *                     має шляху обходу або масового індексування Drive
 *   tasks           - proposals.create(kind=tasks.create), S-8-4
 * `gmail.send` НЕМАЄ свідомо (ADR-019): запрошення шле Google з події
 * `attendees`, а «надіслати лист» лишається неможливим на рівні прав.
 * @type {readonly string[]}
 */
export const CORE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/tasks',
]);

/**
 * Ширші скоупи, які ВКЛЮЧАЮТЬ потрібний. Потрібне для барʼєра можливостей:
 * токен, виданий процедурою етапу 0, має `calendar.readonly` +
 * `calendar.events`, а не єдиний `auth/calendar`, і вимагати дослівного
 * збігу означало б вимкнути календар у той самий день, коли код виїде в
 * прод - до перевидання токена. Звірка `auditScopes` при цьому лишається
 * СУВОРОЮ: ширший скоуп там і далі рахується зайвим, бо він і є зайвим.
 * @type {Record<string, readonly string[]>}
 */
export const SCOPE_INCLUDED_IN = Object.freeze({
  'https://www.googleapis.com/auth/calendar.events': ['https://www.googleapis.com/auth/calendar'],
  'https://www.googleapis.com/auth/drive.file': ['https://www.googleapis.com/auth/drive'],
  'https://www.googleapis.com/auth/drive.readonly': ['https://www.googleapis.com/auth/drive'],
  'https://www.googleapis.com/auth/gmail.readonly': [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ],
});

/**
 * Можливість → скоуп, без якого вона не працює. Потрібне для S-8-7: власник
 * має чути «Tasks ще не підключено», а не «HTTP 403».
 * @type {Record<string, string>}
 */
export const SCOPE_BY_FEATURE = Object.freeze({
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  mail: 'https://www.googleapis.com/auth/gmail.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts',
  drive: 'https://www.googleapis.com/auth/drive.file',
  drive_read: 'https://www.googleapis.com/auth/drive.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks',
});

/** Людська назва можливості для повідомлення власнику.
 *  @type {Record<string, string>} */
const FEATURE_TITLE = Object.freeze({
  calendar: 'Календар',
  mail: 'Пошта',
  contacts: 'Контакти',
  drive: 'Drive',
  drive_read: 'читання Drive',
  tasks: 'Tasks',
});

/** Закінчення прикметника під рід назви можливості («недоступн-а/-е/-і»).
 *  @type {Record<string, string>} */
const FEATURE_ENDING = Object.freeze({
  calendar: 'ий',
  mail: 'а',
  contacts: 'і',
  drive: 'ий',
  drive_read: 'е',
  tasks: 'і',
});

/**
 * Рядок `scope` з відповіді OAuth → набір скоупів. Google віддає їх через
 * пробіл; порожній рядок/не рядок → null («невідомо»), і це НЕ те саме, що
 * порожній набір («не видано жодного»): невідоме не має права нічого
 * блокувати, бо кеш токена пишеться best-effort і поля могло просто не бути.
 * @param {unknown} raw
 * @returns {string[] | null}
 */
export function parseGrantedScopes(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length ? [...new Set(parts)].sort() : null;
}

/**
 * Звірка виданого з потрібним. `extra` - не косметика: будь-що поза
 * CORE_SCOPES означає, що токен дає більше, ніж ядро вміє й має право
 * робити.
 * @param {readonly string[] | null | undefined} granted
 * @returns {{ known: boolean, ok: boolean, missing: string[], extra: string[] }}
 */
export function auditScopes(granted) {
  if (!granted) return { known: false, ok: true, missing: [], extra: [] };
  const have = new Set(granted);
  const need = new Set(CORE_SCOPES);
  const missing = CORE_SCOPES.filter((s) => !have.has(s));
  const extra = [...have].filter((s) => !need.has(s)).sort();
  return { known: true, ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * Чи видано скоуп для можливості. `granted === null` (невідомо) → true:
 * блокувати за відсутністю доказу означало б вимкнути календар щоразу, коли
 * запис кешу токена не вдався.
 * @param {readonly string[] | null | undefined} granted
 * @param {string} feature
 */
export function hasFeatureScope(granted, feature) {
  const scope = SCOPE_BY_FEATURE[feature];
  if (!scope) throw new Error(`google-scopes: невідома можливість «${feature}»`);
  if (!granted) return true;
  if (granted.includes(scope)) return true;
  // Ширший виданий скоуп покриває вужчий потрібний - інакше токен, у якому
  // замість `calendar.events` стоїть повний `auth/calendar`, вимкнув би
  // календар, хоч прав у нього більше, ніж треба.
  return (SCOPE_INCLUDED_IN[scope] ?? []).some((wider) => granted.includes(wider));
}

/**
 * Текст відмови для власника (S-8-7). Іменем можливості, не скоупом: рядок
 * читає людина в чаті.
 * @param {string} feature
 */
export function featureNotConnectedText(feature) {
  const title = FEATURE_TITLE[feature] ?? feature;
  // Два рядки, не один (A2 прогону 08.09): що сталось - і що з цим робити.
  // Технічна причина в дужках, бо власнику вона потрібна лише як довідка,
  // коли він дійде до перевидання токена.
  return [
    `⚠️ ${title} зараз недоступн${FEATURE_ENDING[feature] ?? 'е'} - Google не дав на це права.`,
    `Що зробити: перевидати токен - node scripts/google-auth.mjs (потрібен скоуп ${SCOPE_BY_FEATURE[feature] ?? feature}; покрокове - docs/ops/secrets.md).`,
  ].join(String.fromCharCode(10));
}

/**
 * Текст алерту про зайві скоупи - у системну тему. Окремо від missing: брак
 * ламає можливість (це побачить власник сам), а зайве не ламає нічого й тому
 * не буде помічене ніколи, якщо про нього не сказати.
 * @param {string[]} extra
 */
export function extraScopesAlertText(extra) {
  return [
    `⚠️ Токен Google має ${extra.length} зайвих прав понад те, що потрібне асистенту.`,
    `Що зробити: перевидати токен - node scripts/google-auth.mjs (зайве: ${extra.join(', ')}; зайві права діють і тоді, коли код ними не користується).`,
  ].join(String.fromCharCode(10));
}
