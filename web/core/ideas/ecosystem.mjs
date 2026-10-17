import project from '../../../package.json' with { type: 'json' };

// Product knowledge, not a claim to have inspected arbitrary live source code.
// Paths are checked in tests; no owner facts, balances, mail or secrets are included.
export const IDEA_AREAS = [
  {
    id: 'ecosystem',
    label: 'Увесь Світанок',
    description:
      'Персональна екосистема одного власника: Telegram Mini App на React, сервер Cloudflare Worker і D1, Telegram-асистент із окремим Brain. Спільні дані та серверні правила.',
    sources: ['web/app/src/App.tsx', 'web/worker.js', 'brain/src/tools/schemas.ts'],
  },
  {
    id: 'plan',
    label: 'План і винагороди',
    description:
      'Власні задачі та чернетки, 9 категорій XP, строгі прийняті обіцянки, частковий прогрес, межа дня 03:00 Києва, подовження дня, шаблони, нагадування, напрями та історія. Винагороди за баланс або досвід; перевірка фінансового запасу. Факти таксі можуть автоматично закривати числову задачу.',
    sources: [
      'web/core/motivation/model.mjs',
      'web/core/motivation/finance-link.mjs',
      'web/app/src/components/plan/PlanScreen.tsx',
    ],
  },
  {
    id: 'finance',
    label: 'Фінанси й таксі',
    description:
      'Рахунки, Monobank, ручні операції, категорії, бюджети, платежі/борги, цілі й резерви. Таксі: каса до/після комісії, особиста частка, готівка, історичні правила авто, перезмінка та розрахунок з парком. Прогноз до перезмінки спирається на повні минулі періоди; очікуваний дохід не є наявними коштами.',
    sources: [
      'web/core/finance/workspace.mjs',
      'web/core/finance/income-forecast.mjs',
      'web/app/src/lib/financeForecast.ts',
    ],
  },
  {
    id: 'assistant',
    label: 'Асистент',
    description:
      'Текст і голос у Telegram, інструменти через серверні policy та спільну базу. Явні дії власника, підтвердження відповідно до їхнього рівня, стабільні ідентифікатори повторів. Не приписувати виконання, фінансову готовність чи дозвіл, яких власник не повідомив.',
    sources: ['brain/src/tools/schemas.ts', 'docs/assistant/persona.md'],
  },
  {
    id: 'calendar',
    label: 'Календар',
    description:
      'Інтеграція Google Calendar; власник переглядає цей календар через Apple Calendar. Явний імпорт події в чернетку плану й додавання обраного блоку після прийняття. Зміна календаря не переписує прийняту XP-обіцянку та не доводить виконання.',
    sources: ['web/google.mjs', 'web/core/motivation/jobs.mjs'],
  },
  {
    id: 'checkin',
    label: 'Чек-ін і стан',
    description:
      'Ранкові, денні й вечірні чек-іни, контекстні уточнення, сон та історія стану. Мініапка показує підтверджений результат і динаміку; пропущене значення не перетворюється на нуль. Уточнення мають бути доречними до відповідей, без зайвого щоденного опитування.',
    sources: [
      'web/core/checkin/adaptive.mjs',
      'web/app/src/components/checkin/CheckinV3Screen.tsx',
      'web/app/src/components/stats/AdaptiveReview.tsx',
    ],
  },
  {
    id: 'briefing',
    label: 'Сьогодні та новини',
    description:
      'Ранковий брифінг, погода, курси валют, історичні події, факти, думки та новини. Дані мають джерела й часові мітки; застарілий або відсутній результат потрібно позначати. Матеріали зберігаються в окремий архів.',
    sources: [
      'web/app/src/components/today/TodayScreen.tsx',
      'web/app/src/components/news/NewsScreen.tsx',
      'web/app/src/api/briefing-schema.ts',
    ],
  },
  {
    id: 'memory',
    label: 'Пам’ять і персоналізація',
    description:
      'Факти та вподобання власника з джерелами й виправленнями, окремий екран пам’яті. Пропозиція пам’яті відрізняється від підтвердженого факту. Для проєктування нової функції не потрібне вивантаження особистого профілю.',
    sources: ['web/api-memory.mjs', 'web/core/tools/facts.mjs'],
  },
  {
    id: 'learning',
    label: 'Навчання та розвиток',
    description:
      'Навчальні матеріали, цілі й заняття асистента; кроки навчання можна власноруч пов’язувати з напрямом і цілями у Плані. Не припускати, що перегляд матеріалу означає засвоєння.',
    sources: ['brain/src/tools/schemas.ts', 'web/core/tools/learning-context.mjs'],
  },
  {
    id: 'bookmarks',
    label: 'Закладки та ідеї',
    description:
      'Швидкі власні нотатки щодо майбутніх змін, проблем та ідей Світанку. Спільний реєстр ideas з номерами, статусами, історією й асистентом. Формулювання є редагованою пропозицією для наступної роботи; саме не впроваджує, не публікує і не погоджує код. Є окремий аналіз репозиторію через ideas.analyze(mode=code).',
    sources: ['web/core/tools/ideas.mjs', 'web/core/ideas/analysis.mjs'],
  },
  {
    id: 'saved',
    label: 'Збережені матеріали',
    description:
      'Окремий архів збережених новин, думок, фактів, питань і дозвілля. Існуючий /saved залишається доступним; це не реєстр власних поправок до застосунку.',
    sources: ['web/app/src/components/saved/SavedScreen.tsx'],
  },
  {
    id: 'leisure',
    label: 'Дозвілля й подорожі',
    description:
      'Добірки подій і місць, особисті реакції, відвідування, плани, календарні перевірки. Подорожі, бажання й супровід через інструменти асистента. Запис плану не означає купівлю квитків чи бронювання.',
    sources: ['web/core/tools/leisure.mjs', 'brain/src/tools/schemas.ts'],
  },
  {
    id: 'miniapp',
    label: 'Інтерфейс мініапки',
    description:
      'Мобільний Telegram WebView, швидкі дії в шапці, нижня навігація, повноекранні допоміжні сторінки, шторки форм, темна/світла тема, доступність і reduced motion. Перший екран має показувати основну дію; другорядні деталі розкриваються за потреби.',
    sources: ['web/app/src/App.tsx', 'web/app/src/components/ui/Sheet.tsx'],
  },
  {
    id: 'system',
    label: 'Система та інтеграції',
    description:
      'Спільні інструменти, системний огляд, черги, облік запитів API, історія та контроль версій Worker/Brain. Секрети залишаються на сервері. Новий зв’язок між екранами повинен використовувати спільне джерело даних та ідемпотентні записи.',
    sources: ['web/worker.js', 'web/core/tools/index.mjs', 'web/core/ops/usage-ledger.mjs'],
  },
];
export const IDEA_KINDS = { idea: 'Нова ідея', improvement: 'Покращення', bug: 'Проблема' };
export function ideaEcosystemContext() {
  return {
    version: project.version,
    reviewedOn: '2026-10-17',
    scope:
      'Перевірена карта можливостей і зв’язків; це не live-доступ до всього коду або особистих даних.',
    areas: IDEA_AREAS,
  };
}
