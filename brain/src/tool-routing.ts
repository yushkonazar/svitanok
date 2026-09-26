// Deterministic tool routing for the interactive chat.  Sending every schema
// on every turn makes the model slower, more expensive and more likely to pick
// an unrelated action.  This is deliberately a *narrowing* layer: Core remains
// the policy authority and an ambiguous/compound request keeps a safe general
// set instead of pretending we understand it.

const GENERAL = ['data_search', 'memory_search', 'facts_get', 'delegate'];

type Route = { words: readonly string[]; tools: readonly string[] };

const ROUTES: readonly Route[] = [
  {
    words: [
      'календар',
      'зустріч',
      'поді',
      'вільн',
      'слот',
      'розклад',
      'план на день',
      'план дня',
      'перебудуй план',
      'розплануй',
    ],
    tools: [
      'calendar_read',
      'plan_intent',
      'plan_draft',
      'plan_accept',
      'plan_update',
      'plan_review',
      'proposals_create',
    ],
  },
  {
    words: ['нагадай', 'нагадуван', 'remind'],
    tools: ['reminders_create', 'reminders_update', 'reminders_cancel', 'data_read'],
  },
  {
    words: ['пошт', 'лист', 'gmail', 'email', 'імейл'],
    // Чернетка відповіді потребує mail-secretary. Він має лише mail.search /
    // mail.read та не може надсилати або змінювати листи, тому delegate тут
    // не розширює права, а повертає заявлений сценарій у досяжний стан.
    tools: ['mail_search', 'mail_read', 'inbox_search', 'proposals_create', 'delegate'],
  },
  {
    // Persona вимагає дати Копірайтеру / Редактору власні зразки до delegate.
    // «Збери мій стиль» є T1-пропозицією style.collect через proposals.create.
    words: ['пост', 'скороти', 'відредаг', 'переклади', 'переклад', 'стиль', 'голосом'],
    tools: ['style_samples', 'delegate', 'proposals_create'],
  },
  {
    // Налаштування плану дня - це факт-setting, не новий план і не worker.
    words: ['увімкни план дня', 'вимкни план дня', 'план лише', 'глибоких'],
    tools: ['facts_get', 'facts_set'],
  },
  {
    words: ['диск', 'drive', 'файл', 'документ', 'таблиц'],
    tools: ['drive_search', 'data_search', 'delegate'],
  },
  {
    words: ['грош', 'витрат', 'бюджет', 'платіж', 'підписк', 'фінанс'],
    tools: ['finance_query', 'finance_rule', 'subscriptions_update', 'data_read', 'delegate'],
  },
  {
    // Google Tasks і Drive-нотатки проходять policy як proposal, тому це не
    // write-доступ моделі, а можливість скласти контрольовану T0/T1 дію.
    words: ['задач', 'task'],
    tools: ['proposals_create'],
  },
  {
    words: ['намалюй', 'зображенн', 'зніми відео', 'відео'],
    tools: ['proposals_create'],
  },
  {
    words: ['маршрут', 'їхати', 'дорог', 'місц', 'ресторан', 'кафе', 'меню', 'подорож'],
    tools: [
      'geo_last',
      'geo_geocode',
      'places_search',
      'places_details',
      'places_menu',
      'routes_eta',
      'trip_brief',
      'delegate',
    ],
  },
  {
    words: ['іде', 'idea', 'задум'],
    tools: [
      'ideas_list',
      'ideas_search',
      'ideas_create',
      'ideas_update',
      'ideas_analyze',
      'ideas_delete',
      'delegate',
    ],
  },
  {
    words: ['бажан', 'wish', 'купити', 'покуп'],
    tools: [
      'wishes_list',
      'wishes_search',
      'wishes_create',
      'wishes_import',
      'wishes_update',
      'wishes_delete',
    ],
  },
  {
    words: ['нотат', 'запис', 'record', 'колекц'],
    tools: [
      'records_create',
      'records_update',
      'records_list',
      'records_search',
      'records_delete',
      'collections_list',
      'collections_create',
      'collections_update',
      'collections_delete',
      'proposals_create',
    ],
  },
  {
    words: ['пам’ят', "пам'ят", 'запам', 'факт про мене', 'профіл'],
    tools: ['memory_search', 'facts_get', 'facts_set', 'facts_delete'],
  },
  {
    words: ['дослід', 'порівняй', 'джерел', 'перевір в інтернеті', 'research'],
    tools: ['delegate', 'data_search', 'memory_search'],
  },
];

const GREETING = /^(?:привіт|вітаю|добрий (?:ранок|день|вечір)|дякую|спасибі|hi|hello)[!,.\s]*$/iu;
const COMPOUND = /(?:\n|;|\b(?:і|та|потім|далі)\b.{0,30}\b(?:і|та|потім|далі)\b)/iu;

/**
 * Choose the smallest useful subset of tools for a chat turn. `available` is
 * always the profile allowlist, so this function can never grant a tool that
 * the profile itself did not expose.
 */
export function routeChatTools(input: string, available: readonly string[]): string[] {
  const text = input.trim().toLocaleLowerCase('uk-UA');
  if (!text || GREETING.test(text)) return [];
  const selected = new Set<string>();
  let matchedRoutes = 0;
  for (const route of ROUTES) {
    if (route.words.some((word) => text.includes(word))) {
      matchedRoutes += 1;
      for (const tool of route.tools) selected.add(tool);
    }
  }
  // A compound request can legitimately span domains. Keep the full profile
  // surface then; correctness wins over a marginal schema saving.
  if (COMPOUND.test(text) || matchedRoutes > 1 || selected.size > 18) return [...available];
  if (selected.size === 0) for (const tool of GENERAL) selected.add(tool);
  return available.filter((tool) => selected.has(tool));
}
