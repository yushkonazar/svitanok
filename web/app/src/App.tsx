import { useState } from 'react';
import { motion } from 'framer-motion';
import { inTelegram, haptic } from './telegram.ts';

// 4 таби дашборда — той самий поділ, що у vanilla-версії. Порт вмісту йде
// поетапно: E1 Статистика, E2 Сьогодні, E3 Новини+Вакансії. Поки — каркас із
// плейсхолдерами, щоб перевірити toolchain (Vite+React+TS+Tailwind) і тему.
const TABS = [
  { id: 'today', label: 'Сьогодні', icon: '☀️' },
  { id: 'news', label: 'Новини', icon: '🗞' },
  { id: 'jobs', label: 'Вакансії', icon: '💼' },
  { id: 'stats', label: 'Статистика', icon: '📊' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function Placeholder({ tab }: { tab: (typeof TABS)[number] }) {
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
  const [active, setActive] = useState<TabId>('today');
  const tab = TABS.find((t) => t.id === active)!;

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-xl flex-col">
      <header className="flex items-center justify-between px-4 pb-2 pt-3">
        <div className="text-lg font-bold">
          <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">
            🌅 Svitanok
          </span>
        </div>
        {!inTelegram() && (
          <span className="rounded-full bg-surface-2 px-2 py-1 text-xs text-muted">демо-режим</span>
        )}
      </header>

      <main className="flex-1 px-4 pb-24">
        {/* Keyed motion.section: зміна active -> React ремоунтить -> нова секція
            програє enter-анімацію. Без AnimatePresence (mode="wait" тримав стару
            секцію під час exit і контент застрягав). */}
        <motion.section
          key={active}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <Placeholder tab={tab} />
        </motion.section>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl">
          {TABS.map((t) => {
            const on = t.id === active;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setActive(t.id);
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
