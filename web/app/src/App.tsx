import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { inTelegram, haptic, startParam, setBackButton } from './telegram.ts';
import { useTheme } from './theme.tsx';
import { dateLabel, dateLabelFromIso } from './lib/dateLabel.ts';
import { useBriefing } from './api/hooks.ts';
import { Fog } from './components/ui/Fog.tsx';
import { StatsScreen } from './components/stats/StatsScreen.tsx';
import { TodayScreen } from './components/today/TodayScreen.tsx';
import { NewsScreen } from './components/news/NewsScreen.tsx';
import { JobsScreen } from './components/jobs/JobsScreen.tsx';

// Оболонка дашборда (дизайн v2, Svitanok.dc.html): туман-фон, хедер (лого/дата/
// тема), скрол-контент, таб-бар-пігулка. Кожен таб = маршрут (deep-link
// /app/#/stats; Telegram startapp=stats). Рамку телефона й фейковий статус-бар з
// макета НЕ переносимо — у реальному вебв'ю це сам вьюпорт і статус-бар ОС.

const TABS = [
  { id: 'today', path: '/', label: 'Сьогодні' },
  { id: 'news', path: '/news', label: 'Новини' },
  { id: 'jobs', path: '/jobs', label: 'Вакансії' },
  { id: 'stats', path: '/stats', label: 'Статистика' },
] as const;

type TabId = (typeof TABS)[number]['id'];

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
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...common}>
      <path d="M5 20V12M12 20V6M19 20v-5" />
    </svg>
  );
}

// start_param -> шлях вкладки. Приймаємо і id ('stats'), і шлях ('/stats').
function pathForStartParam(param: string): string | null {
  const tab = TABS.find((t) => t.id === param || t.path === `/${param}` || t.path === param);
  return tab ? tab.path : null;
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

  const active = TABS.find((t) => t.path === location.pathname) ?? TABS[0];

  // Deep-link: один раз на старті мапимо Telegram start_param на вкладку.
  useEffect(() => {
    const param = startParam();
    if (!param) return;
    const path = pathForStartParam(param);
    if (path && path !== location.pathname) navigate(path, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Невідомий шлях -> домашня.
  useEffect(() => {
    const known = TABS.some((t) => t.path === location.pathname);
    if (!known) navigate('/', { replace: true });
  }, [location.pathname, navigate]);

  // Нативна кнопка «Назад» Telegram: видима поза домашньою, веде на домашню.
  useEffect(() => {
    const onHome = active.path === '/';
    return setBackButton(!onHome, () => navigate('/'));
  }, [active.path, navigate]);

  return (
    <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col">
      <Fog />

      <div className="relative z-[1] flex-1">
        {/* HEADER */}
        <header className="flex items-center gap-2.5 px-5 pb-1.5 pt-2.5">
          <div
            className="grid h-[30px] w-[30px] place-items-center rounded-[9px]"
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
          </div>
        </header>

        {/* CONTENT — зміна маршруту ремоунтить секцію -> fadeUp, як у макеті */}
        <motion.main
          key={active.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className="px-5 pb-[120px] pt-1.5"
        >
          {active.id === 'today' ? (
            <TodayScreen />
          ) : active.id === 'news' ? (
            <NewsScreen />
          ) : active.id === 'jobs' ? (
            <JobsScreen />
          ) : (
            <StatsScreen />
          )}
        </motion.main>
      </div>

      {/* TAB BAR — пігулка, активний таб розкривається з підписом */}
      <nav className="pointer-events-none fixed inset-x-0 bottom-[18px] z-30 flex justify-center">
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
                className={
                  on
                    ? 'flex items-center gap-[7px] rounded-full px-[15px] py-[9px] transition-all duration-[250ms]'
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
