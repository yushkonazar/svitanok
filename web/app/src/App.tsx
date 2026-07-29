import { useEffect, useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { inTelegram, haptic, startParam, setBackButton } from './telegram.ts';
import { postEvent } from './api/client.ts';
import { useTheme } from './theme.tsx';
import { dateLabel, dateLabelFromIso } from './lib/dateLabel.ts';
import { useBriefing } from './api/hooks.ts';
import { Fog } from './components/ui/Fog.tsx';
import { StatsScreen } from './components/stats/StatsScreen.tsx';
import { TodayScreen } from './components/today/TodayScreen.tsx';
import { NewsScreen } from './components/news/NewsScreen.tsx';
import { JobsScreen } from './components/jobs/JobsScreen.tsx';
import { SettingsScreen } from './components/settings/SettingsScreen.tsx';
import { SavedScreen } from './components/saved/SavedScreen.tsx';
import { CheckinScreen } from './components/checkin/CheckinScreen.tsx';

// Оболонка дашборда (дизайн v2, Svitanok.dc.html): туман-фон, хедер (лого/дата/
// тема), скрол-контент, таб-бар-пігулка. Кожен таб = маршрут (deep-link
// /app/#/stats; Telegram startapp=stats). Рамку телефона й фейковий статус-бар з
// макета НЕ переносимо — у реальному вебв'ю це сам вьюпорт і статус-бар ОС.
//
// «Налаштування» (F2) — маршрут /settings, але НЕ таб: як у макеті, це
// повноекранний режим із власним хедером і без таб-бара (пʼятий таб роздув би
// пігулку, а заходять туди зрідка).

// ⚠️ Пʼять табів — СТЕЛЯ. Поміряно рендером у найгіршому випадку (активна
// «Статистика», найдовший підпис): пігулка 317px. Вона живе у fixed inset-x-0,
// тобто міряється проти ширини екрана: на 390px запас 73px, на вузькому 360px —
// 43px, на 320px лишається 3px. Шостого таба не буде — наступний екран робити
// повноекранним маршрутом (як /saved), а не табом.
const TABS = [
  { id: 'today', path: '/', label: 'Сьогодні' },
  { id: 'news', path: '/news', label: 'Новини' },
  { id: 'jobs', path: '/jobs', label: 'Вакансії' },
  { id: 'checkin', path: '/checkin', label: 'Чек-ін' },
  { id: 'stats', path: '/stats', label: 'Статистика' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const SETTINGS_PATH = '/settings';
const SAVED_PATH = '/saved';

/**
 * Повноекранні маршрути — НЕ таби: власний хедер «‹ Назва», без таб-бара.
 * Пʼятий/шостий таб роздув би пігулку, а заходять сюди зрідка.
 */
const FULL: Array<{ path: string; title: string }> = [
  { path: SETTINGS_PATH, title: 'Налаштування' },
  { path: SAVED_PATH, title: 'Збережене' },
];

/** Усі відомі маршрути — і таби, і повноекранні (для редіректу/deep-link). */
const KNOWN_PATHS: string[] = [...TABS.map((t) => t.path), ...FULL.map((f) => f.path)];

function TabIcon({ id, active }: { id: TabId; active: boolean }) {
  const sw = active ? 2 : 1.6;
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: sw,
    strokeLinecap: 'round' as const,
  };
  if (id === 'today')
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
      </svg>
    );
  if (id === 'news')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="M7 9.5h6M7 13h10" />
      </svg>
    );
  if (id === 'jobs')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" {...common}>
        <rect x="3" y="7" width="18" height="13" rx="2.5" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      </svg>
    );
  if (id === 'checkin')
    return (
      // Календар із галочкою: чек-ін — це «відмітився за сьогодні».
      <svg width="18" height="18" viewBox="0 0 24 24" {...common}>
        <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
        <path d="M8 2.5v4M16 2.5v4M8.5 13.5l2.5 2.5 4.5-4.5" />
      </svg>
    );
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...common}>
      <path d="M5 20V12M12 20V6M19 20v-5" />
    </svg>
  );
}

// start_param -> шлях. Приймаємо і id ('stats'), і шлях ('/stats').
function pathForStartParam(param: string): string | null {
  const tab = TABS.find((t) => t.id === param || t.path === `/${param}` || t.path === param);
  if (tab) return tab.path;
  return FULL.find((f) => f.path === param || f.path === `/${param}`)?.path ?? null;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';

  // Дата в хедері — БРИФІНГУ (generatedAt), не пристрою: якщо крон не спрацював
  // і брифінг учорашній, це має бути видно. Черга спільна (кеш), зайвого fetch
  // не буде. Поки вантажиться — дата пристрою як плейсхолдер.
  const { data: briefData } = useBriefing();
  const headerDate = dateLabelFromIso(briefData?.brief.generatedAt) ?? dateLabel();

  const full = FULL.find((f) => f.path === location.pathname);
  const active = TABS.find((t) => t.path === location.pathname) ?? TABS[0];

  // Deep-link: один раз на старті мапимо Telegram start_param на вкладку.
  useEffect(() => {
    const param = startParam();
    if (!param) return;
    const path = pathForStartParam(param);
    if (path && path !== location.pathname) navigate(path, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Подія «відкрито» — раз на завантаження. Стрік «днів поспіль», тижневі
  // стовпчики, теплокарта 12 тижнів і «час до відкриття» ЖИВЛЯТЬСЯ з days.opens,
  // а її інкрементує лише ця подія. Старий ваніль-дашборд слав її при кожному
  // завантаженні; React-міграція емісію загубила, тож усі ці метрики стояли
  // нулями (стрік = 0 «ніби втрата даних»). postEvent сам no-op поза Telegram,
  // тож демо не чіпає; сервер (worker.js: type==='open') давно її обробляє.
  useEffect(() => {
    void postEvent('open', {}).catch(() => {});
  }, []);

  // Невідомий шлях -> домашня.
  useEffect(() => {
    if (!KNOWN_PATHS.includes(location.pathname)) navigate('/', { replace: true });
  }, [location.pathname, navigate]);

  // Нова вкладка починається ЗГОРИ. Скролер тут — сам документ (немає жодного
  // overflow-контейнера, оболонка лише min-h-[100dvh]), тож позиція скролу
  // переживає зміну маршруту: прогорнув «Сьогодні» до «В цей день», тапнув
  // «Новини» — і опинявся посеред стрічки, ніби вже читав її. Ремоунт
  // motion.main цього не чіпає: він міняє ВМІСТ, а не позицію вьюпорта.
  // useLayoutEffect, а не useEffect: скидання має статись ДО кадру, інакше
  // видно стрибок уже намальованого контенту.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // Нативна кнопка «Назад» Telegram: видима поза домашньою, веде на домашню.
  useEffect(() => {
    const onHome = !full && active.path === '/';
    return setBackButton(!onHome, () => navigate('/'));
  }, [active.path, full, navigate]);

  return (
    <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col">
      <Fog />

      <div className="relative z-[1] flex-1">
        {/* HEADER — у налаштуваннях перетворюється на «‹ Налаштування» */}
        <header className="flex items-center gap-2.5 px-5 pb-1.5 pt-2.5">
          {full ? (
            <>
              <button
                type="button"
                aria-label="Назад"
                onClick={() => {
                  navigate('/');
                  haptic('light');
                }}
                className="grid h-9 w-9 place-items-center rounded-xl border border-glassb bg-glass"
              >
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-tx)"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <div className="text-[18px] font-extrabold tracking-[-0.01em]">{full.title}</div>
            </>
          ) : (
            <>
              <div
                className="sheen grid h-[30px] w-[30px] place-items-center rounded-[9px]"
                style={{ background: 'var(--grad)' }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-onacc)"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M5 16a7 7 0 0 1 14 0" />
                  <path d="M3 20h18M12 4v3M5.6 8.6 7 10M18.4 8.6 17 10" />
                </svg>
              </div>
              <div className="flex flex-col">
                <div className="text-[15px] font-extrabold tracking-[-0.01em]">Svitanok</div>
                <div className="font-mono text-[9.5px] font-medium text-tx3">{headerDate}</div>
              </div>
            </>
          )}
          <div className="ml-auto flex gap-2">
            {!inTelegram() && (
              <span className="self-center rounded-full bg-glass px-2 py-1 font-mono text-[9px] text-tx3">
                демо
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                toggle();
                haptic('light');
              }}
              aria-label={isDark ? 'Увімкнути світлу тему' : 'Увімкнути темну тему'}
              className="grid h-9 w-9 place-items-center rounded-xl border border-glassb bg-glass"
            >
              {isDark ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-a2)"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-a1)"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                >
                  <path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5Z" />
                </svg>
              )}
            </button>
            {/* Збережене — ЛІВОРУЧ від налаштувань (фідбек власника: перенести
                до теми й налаштувань). Доти вхід у /saved жив рядком усередині
                блоку «Інтереси» на вкладці статистики — тобто щоб дістатись
                архіву, треба було спершу згадати, що він саме там. Тепер це
                глобальна дія в хедері, поруч із рештою глобальних. */}
            {!full && (
              <button
                type="button"
                aria-label="Збережене"
                onClick={() => {
                  navigate(SAVED_PATH);
                  haptic('light');
                }}
                className="grid h-9 w-9 place-items-center rounded-xl border border-glassb bg-glass"
              >
                {/* Закладка — той самий 🔖, що був у рядку, але іконкою: емодзі
                    в ряду зі stroke-іконками виглядало б чужорідно. */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-tx2)"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 4h12v16l-6-4-6 4V4Z" />
                </svg>
              </button>
            )}
            {/* Налаштування — ПРАВОРУЧ від теми (фідбек власника). На
                повноекранних маршрутах ховаємо: там уже є «Назад», і третя
                іконка поруч із нею тільки тісниться. */}
            {!full && (
              <button
                type="button"
                aria-label="Налаштування"
                onClick={() => {
                  navigate(SETTINGS_PATH);
                  haptic('light');
                }}
                className="grid h-9 w-9 place-items-center rounded-xl border border-glassb bg-glass"
              >
                {/* Повзунки, а НЕ шестерня: шестерня — це коло з 8 променями,
                    тобто на 18px вона неотличима від сонця в кнопці теми поруч.
                    Повзунки ні з чим не сплутаєш. */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-tx2)"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                >
                  <path d="M4 8h4M13 8h7M4 16h9M18 16h2" />
                  <circle cx="10.5" cy="8" r="2.4" />
                  <circle cx="15.5" cy="16" r="2.4" />
                </svg>
              </button>
            )}
          </div>
        </header>

        {/* CONTENT — зміна маршруту ремоунтить секцію -> fadeUp, як у макеті */}
        <motion.main
          key={full ? full.path : active.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className={full ? 'px-5 pb-10 pt-2.5' : 'px-5 pb-[120px] pt-1.5'}
        >
          {full ? (
            full.path === SETTINGS_PATH ? (
              <SettingsScreen />
            ) : (
              <SavedScreen />
            )
          ) : active.id === 'today' ? (
            <TodayScreen />
          ) : active.id === 'news' ? (
            <NewsScreen />
          ) : active.id === 'jobs' ? (
            <JobsScreen />
          ) : active.id === 'checkin' ? (
            <CheckinScreen />
          ) : (
            <StatsScreen />
          )}
        </motion.main>
      </div>

      {/* TAB BAR — пігулка, активний таб розкривається з підписом. У
          налаштуваннях сховано (повноекранний режим, як у макеті). */}
      <nav
        hidden={!!full}
        className="pointer-events-none fixed inset-x-0 bottom-[18px] z-30 flex justify-center"
      >
        <div
          className="pointer-events-auto flex gap-1 rounded-full border border-glassb bg-bg2 p-1.5 backdrop-blur-[28px]"
          style={{ boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}
        >
          {TABS.map((t) => {
            const on = t.id === active.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-label={t.label}
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  navigate(t.path);
                  haptic('light');
                }}
                // sheen — лише на АКТИВНІЙ: вона градієнтна й найбільша на екрані
                // (≈125px), тож саме на ній відблиск і видно. Пігулка живе в
                // fixed-таббарі, тобто рух присутній на кожному екрані завжди.
                className={
                  on
                    ? 'sheen flex items-center gap-[7px] rounded-full px-[15px] py-[9px] transition-all duration-[250ms]'
                    : 'grid h-9 w-[42px] place-items-center rounded-full text-tx3 transition-all duration-[250ms]'
                }
                style={on ? { background: 'var(--grad)', color: 'var(--color-onacc)' } : undefined}
              >
                <TabIcon id={t.id} active={on} />
                {on && <span className="text-xs font-bold">{t.label}</span>}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
