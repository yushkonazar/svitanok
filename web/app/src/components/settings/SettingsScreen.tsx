import { useState } from 'react';
import { useSettings, useSaveSettings, useStats, useSetGoal } from '../../api/hooks.ts';
import { getDemoState, setDemoState, type DemoState } from '../../api/client.ts';
import { inTelegram, haptic } from '../../telegram.ts';
import { useTheme, type ThemePref } from '../../theme.tsx';
import { SectionLabel, Ph } from '../ui/primitives.tsx';
import { LoadingSkeleton, ErrorState, SkeletonBar } from '../ui/states.tsx';
import { Switch, Chip, Stepper, SettingRow } from '../ui/controls.tsx';
import { useQueryClient } from '@tanstack/react-query';

// Екран «Налаштування» (дизайн v2, Svitanok.dc.html; роадмеп v3, F2).
//
// Що з макета НЕ перенесено і ЧОМУ:
// - «Робочі години» — у бекенді немає жодного споживача цієї настройки (нагадування
//   гейтяться тихими годинами, брифінг — вікном sendHour у config.yml). Тумблер
//   без ефекту гірший за його відсутність, тож зʼявиться разом зі споживачем.
// - Кнопка «Підключити» в конекторах — OAuth-консент Google робиться разово
//   секретами деплою (GOOGLE_*), а не з Mini App. Показуємо чесний СТАТУС.
// Що додано понад макет: діапазон тихих годин реально редагується (у макеті це
// був статичний підпис), а демо-стан живе лише поза Telegram.

const MODULES: Array<{ id: string; icon: string; label: string }> = [
  { id: 'weather', icon: '⛅', label: 'Погода' },
  { id: 'currency', icon: '💱', label: 'Курс валют' },
  { id: 'mock', icon: '❓', label: 'Питання дня' },
  { id: 'fact', icon: '🧠', label: 'Факт дня' },
  { id: 'stoic', icon: '📜', label: 'Думка дня' },
  { id: 'onthisday', icon: '🏛', label: 'У цей день' },
  { id: 'news', icon: '📰', label: 'Новини' },
  { id: 'jobs', icon: '💼', label: 'Вакансії' },
];

const THEMES: Array<{ id: ThemePref; label: string }> = [
  { id: 'dark', label: '🌙 Темна' },
  { id: 'light', label: '☀️ Світла' },
  { id: 'auto', label: '🕘 Авто' },
];

const DEMO_STATES: Array<{ id: DemoState; label: string }> = [
  { id: 'ready', label: 'Дані' },
  { id: 'loading', label: 'Скелетон' },
  { id: 'empty', label: 'Порожньо' },
  { id: 'error', label: 'Помилка' },
];

const GOAL_MIN = 1;
const GOAL_MAX = 10;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

/** Поле часу: нативний input[type=time] у шкірі дизайну (color-scheme — з теми). */
function TimeField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <input
      type="time"
      value={value}
      aria-label={label}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="rounded-[9px] border border-glassb bg-glass px-2.5 py-1.5 font-mono text-[12px] font-semibold text-tx"
    />
  );
}

export function SettingsScreen() {
  const qc = useQueryClient();
  const { pref, setPref } = useTheme();
  // Демо-стан живе модульною змінною в client.ts (його читають fetch-функції поза
  // React), тож тримаємо дзеркало в стані — інакше активний чіп не перемалювався б.
  const [demo, setDemo] = useState<DemoState>(getDemoState);
  const { data, isLoading, isError, error, refetch } = useSettings();
  const { data: statsData, isError: statsError } = useStats();
  const save = useSaveSettings();
  const setGoal = useSetGoal();

  // null = ще не знаємо (вантажиться / впало). Свідомо БЕЗ фолбека на число.
  const goal = statsData?.stats.goal.weeklyTarget ?? null;

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Перевір з’єднання й спробуй ще раз.'}
        onRetry={() => refetch()}
      />
    );
  }

  const { settings, connectors } = data;

  // Шлемо ПАТЧ: зведення до повного блоба — в useSaveSettings, поверх кешу.
  // Робити це тут, зі `settings` рендера, було б гонкою: два тапи до
  // перемальовування прочитали б однаковий стан, і другий загубив би перший.
  const saveQuiet = (patch: Partial<typeof settings.quiet>) => save.mutate({ quiet: patch });
  const saveModule = (id: string, on: boolean) => save.mutate({ modules: { [id]: on } });

  const connectorRow = (icon: string, label: string, on: boolean) => (
    <SettingRow
      key={label}
      icon={
        <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[11px] border border-glassb bg-glass text-base">
          {icon}
        </div>
      }
      title={label}
      hint={
        <span style={{ color: on ? 'var(--color-pos)' : 'var(--color-tx3)' }}>
          {on ? 'Синхронізовано' : 'Не підключено'}
        </span>
      }
    >
      <span className="ml-auto flex-none rounded-full border border-glassb bg-glass px-[11px] py-1.5 text-[11px] font-semibold text-tx2">
        {on ? 'Активний' : 'Вимкнено'}
      </span>
    </SettingRow>
  );

  return (
    <div className="flex flex-col gap-6">
      <Section title="РОЗКЛАД">
        <SettingRow
          title="Тихі години"
          hint={
            settings.quiet.enabled
              ? `${settings.quiet.from} – ${settings.quiet.to} · нагадування чекають ранку`
              : 'нагадування приходять будь-коли'
          }
        >
          <Switch
            label="Тихі години"
            checked={settings.quiet.enabled}
            onChange={(enabled) => saveQuiet({ enabled })}
          />
        </SettingRow>

        {settings.quiet.enabled && (
          <div className="flex items-center gap-2 pl-0.5">
            <TimeField
              label="Початок тихих годин"
              value={settings.quiet.from}
              onChange={(from) => saveQuiet({ from })}
            />
            <span className="text-tx3">–</span>
            <TimeField
              label="Кінець тихих годин"
              value={settings.quiet.to}
              onChange={(to) => saveQuiet({ to })}
            />
          </div>
        )}
      </Section>

      {/* Ціль живе в іншій черзі (['stats']) — тож і стани в неї свої. Раніше тут
          стояв фолбек `?? 5`: він малював вигадану пʼятірку, поки статистика ще
          вантажилась, і тап по слайдеру ЗАТИРАВ би нею справжню ціль. */}
      <Section title="ТИЖНЕВА ЦІЛЬ ПОДАЧ">
        {goal === null ? (
          statsError ? (
            <Ph>Ціль недоступна — статистика не завантажилась.</Ph>
          ) : (
            <SkeletonBar height={30} />
          )
        ) : (
          <>
            <div className="flex items-center">
              <span className="text-[13.5px] font-semibold">Відгуків на тиждень</span>
              <span
                className="ml-auto font-mono text-[15px] font-bold"
                style={{ color: 'var(--color-a2)' }}
              >
                {goal}
              </span>
            </div>
            <Stepper
              label="Тижнева ціль подач"
              value={goal}
              min={GOAL_MIN}
              max={GOAL_MAX}
              onChange={(value) => setGoal.mutate({ value })}
            />
          </>
        )}
      </Section>

      <Section title="КОНЕКТОРИ">
        {connectorRow('📅', 'Calendar', connectors.calendar)}
        {connectorRow('✉️', 'Gmail', connectors.gmail)}
        {!connectors.google && (
          <p className="text-[11.5px] leading-snug text-tx3">
            Google підключається секретами деплою (GOOGLE_*), не з застосунку.
          </p>
        )}
      </Section>

      <Section title="МОДУЛІ БРИФІНГУ">
        {MODULES.map((m) => {
          // Відсутність оверрайду = дефолт config.yml; для цих восьми там
          // enabled:true (інваріант закріплено тестом tests/config.test.ts).
          const on = settings.modules[m.id] ?? true;
          return (
            <SettingRow
              key={m.id}
              icon={<span className="w-[22px] flex-none text-center text-[15px]">{m.icon}</span>}
              title={m.label}
            >
              <Switch label={m.label} checked={on} onChange={(next) => saveModule(m.id, next)} />
            </SettingRow>
          );
        })}
        <p className="text-[11.5px] leading-snug text-tx3">
          Вимкнений модуль не потрапляє в завтрашній брифінг.
        </p>
      </Section>

      <Section title="ТЕМА">
        <div className="flex gap-2" role="radiogroup" aria-label="Тема">
          {THEMES.map((t) => (
            <Chip key={t.id} active={pref === t.id} pressed={pref === t.id} onClick={() => setPref(t.id)}>
              {t.label}
            </Chip>
          ))}
        </div>
      </Section>

      {/* Демо-стан — лише поза Telegram: у справжньому вебвʼю дані реальні, і
          підміняти їх нема ні сенсу, ні права. */}
      {!inTelegram() && (
        <Section title="ДЕМО-СТАН ДАНИХ · ЛИШЕ ПОЗА TELEGRAM">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Демо-стан даних">
            {DEMO_STATES.map((d) => (
              <Chip
                key={d.id}
                active={demo === d.id}
                pressed={demo === d.id}
                onClick={() => {
                  setDemoState(d.id);
                  setDemo(d.id);
                  haptic('light');
                  // resetQueries, а НЕ invalidateQueries: інвалідація лишає старі
                  // дані в кеші й довантажує у фоні, тож isLoading не настає — і
                  // «Скелетон» показував би попередні дані замість скелетона.
                  // Скидання повертає черги в pending -> екрани грають стан із нуля.
                  qc.resetQueries();
                }}
              >
                {d.label}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      <div className="pt-1 text-center font-mono text-[10px] font-medium text-tx3">
        Svitanok · дизайн v2{!inTelegram() && ' · демо-режим'}
      </div>
    </div>
  );
}
