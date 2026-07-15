import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { inTelegram, haptic, startParam, setBackButton } from './telegram.ts';
import { useTheme } from './theme.tsx';
import { StatsScreen } from './components/stats/StatsScreen.tsx';
import { TodayScreen } from './components/today/TodayScreen.tsx';

// 4 таби дашборда — той самий поділ, що у vanilla-версії. Кожен таб = маршрут
// (deep-link: /app/#/stats шериться, а Telegram startapp=stats відкриває його
// напряму). Порт вмісту йде поетапно: E1 Статистика, E2 Сьогодні, E3 Новини+
// Вакансії. Поки — плейсхолдери, щоб перевірити toolchain, тему й навігацію.
const TABS = [
  { id: 'today', path: '/', label: 'Сьогодні', icon: '☀️' },
  { id: 'news', path: '/news', label: 'Новини', icon: '🗞' },
  { id: 'jobs', path: '/jobs', label: 'Вакансії', icon: '💼' },
  { id: 'stats', path: '/stats', label: 'Статистика', icon: '📊' },
] as const;

type Tab = (typeof TABS)[number];

// start_param -> шлях вкладки. Приймаємо і id ('stats'), і назву шляху ('/stats').
function pathForStartParam(param: string): string | null {
  const tab = TABS.find((t) => t.id === param || t.path === `/${param}` || t.path === param);
  return tab ? tab.path : null;
}

function Placeholder({ tab }: { tab: Tab }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
      <div className="text-5xl">{tab.icon}</div>
      <div className="text-lg font-semibold">{tab.label}</div>
      <div className="max-w-xs text-sm text-muted">
        React-версія цієї вкладки з’явиться в наступних кроках міграції.
      </div>
    </div>
  );
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();

  const active = TABS.find((t) => t.path === location.pathname) ?? TABS[0];

  // Deep-link: один раз на старті мапимо Telegram start_param на вкладку.
  useEffect(() => {
    const param = startParam();
    if (!param) return;
    const path = pathForStartParam(param);
    if (path && path !== location.pathname) navigate(path, { replace: true });
    // Порожні залежності: лише при монтуванні (start_param не змінюється в сесії).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Невідомий шлях (напр. /app/#/foo) -> нормалізуємо на домашню.
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
    <div className="mx-auto flex min-h-[100dvh] max-w-xl flex-col">
      <header className="flex items-center justify-between px-4 pb-2 pt-3">
        <div className="text-lg font-bold">
          <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">
            🌅 Svitanok
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!inTelegram() && (
            <span className="rounded-full bg-surface-2 px-2 py-1 text-xs text-muted">
              демо-режим
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              toggle();
              haptic('light');
            }}
            aria-label={theme === 'dark' ? 'Увімкнути світлу тему' : 'Увімкнути темну тему'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-base transition-colors hover:bg-border"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 pb-24">
        {/* Keyed motion.section: зміна маршруту -> ремоунт -> enter-анімація.
            Без AnimatePresence (mode="wait" тримав стару секцію під час exit
            і контент застрягав). */}
        <motion.section
          key={active.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          {active.id === 'today' ? (
            <TodayScreen />
          ) : active.id === 'stats' ? (
            <StatsScreen />
          ) : (
            <Placeholder tab={active} />
          )}
        </motion.section>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl">
          {TABS.map((t) => {
            const on = t.id === active.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  navigate(t.path);
                  haptic('light');
                }}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
                  on ? 'text-accent' : 'text-muted'
                }`}
              >
                <span className="text-lg leading-none">{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
