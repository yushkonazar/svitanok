import { AdaptivePreferences } from '../checkin/AdaptivePreferences.tsx';
import { OperationsPanel } from './OperationsPanel.tsx';
import { MemoryPanel } from './MemoryPanel.tsx';
import { version as appVersion } from '../../../package.json';
import {
  NEWS_SOURCE_CATALOG,
  DEFAULT_NEWS_SOURCES,
  NEWS_FEEDS,
  canonicalNewsTopic,
} from '../../../../core/brief/news-catalog.mjs';
import { PageHeading } from '../ui/PageHeading.tsx';
import { usePresentation, savePresentation } from '../../lib/presentation.ts';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSettings, useSaveSettings, useNewsSnapshot } from '../../api/hooks.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { getDemoState, setDemoState, type DemoState } from '../../api/client.ts';
import {
  inTelegram,
  haptic,
  tg,
  checkHomeScreenStatus,
  addToHomeScreen,
  type HomeScreenStatus,
} from '../../telegram.ts';
import { useTheme, type ThemePref } from '../../theme.tsx';
import { SectionLabel } from '../ui/primitives.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { Switch, Chip, SettingRow } from '../ui/controls.tsx';
import { cascade } from '../ui/Cascade.tsx';
import { useQueryClient, useIsMutating, useMutationState } from '@tanstack/react-query';
import { DeletionReceiptsBlock } from './DeletionReceiptsBlock.tsx';
import { WorkerQualityBlock } from './WorkerQualityBlock.tsx';

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
  { id: 'fact', icon: '🧠', label: 'Факт дня' },
  { id: 'stoic', icon: '📜', label: 'Цитата дня' },
  { id: 'onthisday', icon: '🏛', label: 'У цей день' },
  { id: 'news', icon: '📰', label: 'Новини' },
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}
function SettingsSaveStatus() {
  const pending = useIsMutating({ mutationKey: ['settings-save'] });
  const history = useMutationState({
    filters: { mutationKey: ['settings-save'] },
    select: (mutation) => mutation.state,
  });
  const latest = history.at(-1);
  if (pending)
    return (
      <p role="status" className="renewal-chart-note">
        Зберігаю налаштування…
      </p>
    );
  if (latest?.status === 'error')
    return (
      <p role="alert" className="text-neg text-sm">
        {latest.error instanceof Error
          ? latest.error.message
          : 'Не вдалося зберегти налаштування. Спробуй знову.'}
      </p>
    );
  if (latest?.status === 'success')
    return (
      <p role="status" className="renewal-chart-note">
        {inTelegram()
          ? 'Налаштування збережено'
          : 'Демонстраційні налаштування збережено на цьому пристрої'}
      </p>
    );
  return null;
}
function NewsUsage() {
  const news = useNewsSnapshot();
  const usage = news.data?.usage;
  if (!usage) return null;
  return (
    <details className="renewal-inset mt-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Обробка новин · {usage.period}
      </summary>
      <p className="renewal-muted mt-3">
        Перекладено через Google: {usage.translatedCharacters.toLocaleString('uk-UA')} символів.
        Редакторські запити: {usage.editorCalls}. Орієнтовна вартість AI: $
        {usage.estimatedEditorUsd.toFixed(3)}.
      </p>
      <p className="renewal-chart-note mt-2">
        Це облік новин Світанку. Рахунок Google за переклад враховує також інше використання сервісу
        й спільний щомісячний кредит.
      </p>
    </details>
  );
}

/** Поле часу: нативний input[type=time] у шкірі дизайну (color-scheme — з теми). */
function TimeField({
  value,
  onChange,
  label,
  tabIndex,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  tabIndex?: number;
}) {
  return (
    <input
      type="time"
      value={value}
      aria-label={label}
      tabIndex={tabIndex}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="rounded-[9px] border border-glassb bg-glass px-2.5 py-1.5 font-mono text-[12px] font-semibold text-tx"
    />
  );
}

/**
 * Ярлик на головний екран пристрою (Bot API 8.0+, дослідження Telegram-механік —
 * фідбек власника). Обходить усю навігацію Telegram: у групі немає персональної
 * menu-кнопки бота (лише в приватному чаті), а reply-клавіатура ненадійна на
 * Desktop у супергрупах/форум-темах (баг клієнта) — ярлик працює завжди
 * однаково, незалежно від того, де саме відкрита розмова з ботом.
 *
 * status стартує 'unsupported' і checkHomeScreenStatus підтверджує/спростовує
 * це асинхронно — старий клієнт (< 8.0) чи поза Telegram лишає секцію
 * невидимою, а не показує кнопку, що нічого не зробить.
 */
function HomeScreenSection() {
  const [status, setStatus] = useState<HomeScreenStatus>('unsupported');

  useEffect(() => {
    checkHomeScreenStatus(setStatus);
    const onAdded = () => setStatus('added');
    tg?.onEvent?.('homeScreenAdded', onAdded);
    return () => tg?.offEvent?.('homeScreenAdded', onAdded);
  }, []);

  if (status === 'unsupported') return null;

  return (
    <Section title="ГОЛОВНИЙ ЕКРАН">
      {status === 'added' ? (
        <p className="text-[13px] font-semibold" style={{ color: 'var(--color-pos)' }}>
          ✅ Додано на головний екран
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            addToHomeScreen();
          }}
          className="rounded-[11px] border border-glassb bg-glass px-3.5 py-2.5 text-left text-[13px] font-semibold"
        >
          📲 Додати Світанок на головний екран
        </button>
      )}
    </Section>
  );
}

export function SettingsScreen() {
  const view = usePresentation();
  const qc = useQueryClient();
  const { pref, setPref } = useTheme();
  // Демо-стан живе модульною змінною в client.ts (його читають fetch-функції поза
  // React), тож тримаємо дзеркало в стані — інакше активний чіп не перемалювався б.
  const [demo, setDemo] = useState<DemoState>(getDemoState);
  const { data, isLoading, isError, error, refetch } = useSettings();
  const save = useSaveSettings();

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

  const muted = settings.mutedTopics;
  // Sources define the current topics, even if the brief is old or contains no news.
  const topics = [
    ...new Set([...NEWS_FEEDS.map((feed) => feed.topic), ...muted].map(canonicalNewsTopic)),
  ].sort((a, b) => a.localeCompare(b, 'uk'));
  const connectorRow = (icon: string, label: string, on: boolean, unknown = false) => (
    <SettingRow
      key={label}
      icon={
        <span className="text-xl" aria-hidden="true">
          {icon}
        </span>
      }
      title={label}
      hint={
        unknown
          ? 'Дозволи ще не перевірені'
          : on
            ? 'Інтеграція налаштована'
            : 'Не підключено або немає дозволу'
      }
    >
      <span className="renewal-pill">
        {unknown ? 'Невідомо' : on ? 'Налаштовано' : 'Недоступно'}
      </span>
    </SettingRow>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeading eyebrow="ТВІЙ СВІТАНОК" title="Підлаштувати" accent="під себе." />
      {!inTelegram() && (
        <p className="renewal-chart-note">
          Демонстрація поза Telegram: ці зміни не змінюють твій справжній профіль Світанку.
        </p>
      )}
      <SettingsSaveStatus />
      <AdaptivePreferences />
      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/finance?action=settings" className="renewal-card">
          <h2 className="font-semibold">Фінанси й нагадування →</h2>
          <p className="renewal-chart-note mt-2">
            Період огляду, таксі, категорії, кредитні ліміти та сповіщення про платежі й чек-ін.
          </p>
        </Link>
        <Link to="/leisure?action=settings" className="renewal-card">
          <h2 className="font-semibold">Дозвілля →</h2>
          <p className="renewal-chart-note mt-2">
            Напрямки добірки, кінотеатри, студентські пільги й автоматичне оновлення.
          </p>
        </Link>
      </div>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold mb-4">Вигляд і відчуття</h2>
        <p className="renewal-chart-note mb-4">
          Ці параметри зберігаються на цьому пристрої. «Авто» повторює тему Telegram, а у браузері —
          системну.
        </p>
        <div className="flex flex-wrap gap-2 mb-4" role="radiogroup" aria-label="Тема">
          {THEMES.map((t) => (
            <Chip
              key={t.id}
              active={pref === t.id}
              pressed={pref === t.id}
              onClick={() => setPref(t.id)}
            >
              {t.label}
            </Chip>
          ))}
        </div>
        {(
          [
            { key: 'calm', title: 'Спокійні анімації', hint: 'Мінімум руху на цьому пристрої' },
            { key: 'haptics', title: 'Тактильний відгук', hint: 'Вібрації в Telegram' },
            {
              key: 'learning',
              title: 'Фокус-таймер на «Сьогодні»',
              hint: 'Власна справа та 15–60 хвилин зосередження',
            },
            {
              key: 'newsPreview',
              title: 'Новина на «Сьогодні»',
              hint:
                settings.modules.news === false
                  ? 'Зараз приховано: збір новин вимкнений'
                  : 'Одна новина з твоєї стрічки',
            },
          ] as const
        ).map((row) => (
          <SettingRow key={row.key} title={row.title} hint={row.hint}>
            <Switch
              label={row.title}
              checked={view[row.key]}
              onChange={(v) => savePresentation({ [row.key]: v })}
            />
          </SettingRow>
        ))}
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold mb-4">Твої джерела новин</h2>
        {NEWS_SOURCE_CATALOG.map(({ id: source, hint }) => {
          const n = settings.news ?? {
            sources: [...DEFAULT_NEWS_SOURCES],
            intervalHours: 3 as const,
          };
          return (
            <SettingRow key={source} title={source} hint={hint}>
              <Switch
                label={`Джерело ${source}`}
                checked={n.sources.includes(source)}
                onChange={(enabled) => save.mutate({ newsSource: { id: source, enabled } })}
              />
            </SettingRow>
          );
        })}
        <label className="renewal-field mt-4">
          Як часто збирати новини
          <select
            value={settings.news?.intervalHours ?? 3}
            onChange={(e) =>
              save.mutate({
                news: { intervalHours: Number(e.target.value) as 3 | 6 | 12 },
              })
            }
          >
            {[3, 6, 12].map((n) => (
              <option key={n} value={n}>
                Кожні {n} {n === 3 ? 'години' : 'годин'}
              </option>
            ))}
          </select>
        </label>
        <p className="renewal-muted mt-3">
          До 30 відібраних матеріалів за оновлення; фактична кількість залежить від доступних новин.
          Переклад кешується. Відкриття стрічки читає готові дані. Джерела, теми й частота спільні з
          асистентом; зміни застосуються під час наступного збору.
        </p>
        <NewsUsage />
        {(settings.news?.sources ?? DEFAULT_NEWS_SOURCES).length === 0 && (
          <p className="renewal-chart-note mt-3">
            Жодного джерела не обрано — нові матеріали не збиратимуться.
          </p>
        )}
        {settings.modules.news === false && (
          <p className="renewal-chart-note mt-3">
            Збір новин вимкнений у блоках нижче. Вибір джерел збережений.
          </p>
        )}
      </section>
      <Section title="СПОВІЩЕННЯ Й ТИХІ ГОДИНИ">
        <p className="renewal-chart-note">
          Час за Києвом. Увімкнути нагадування про платежі та чек-ін можна у фінансових
          налаштуваннях вище.
        </p>
        <SettingRow
          title="Тихі години"
          hint={
            settings.quiet.enabled
              ? `${settings.quiet.from} – ${settings.quiet.to} · нагадування чекають кінця цього проміжку`
              : 'нагадування приходять будь-коли'
          }
        >
          <Switch
            label="Тихі години"
            checked={settings.quiet.enabled}
            onChange={(enabled) => saveQuiet({ enabled })}
          />
        </SettingRow>

        {/* Рядок часу розкривається grid-rows 0fr→1fr (той самий прийом, що
            блоки чек-іну) — раніше він зʼявлявся стрибком. Обгортка живе в DOM
            ЗАВЖДИ: -mt-3 гасить слот gap-3 секції у згорнутому стані, pt-3
            всередині повертає відступ у розгорнутому — разом висота згорнутого
            стану лишається піксель у піксель як до цієї анімації. */}
        <div
          aria-hidden={!settings.quiet.enabled}
          className="-mt-3 grid transition-[grid-template-rows] duration-[350ms] ease-[cubic-bezier(.22,1,.36,1)]"
          style={{ gridTemplateRows: settings.quiet.enabled ? '1fr' : '0fr' }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 pl-0.5 pt-3">
              {/* tabIndex -1 у згорнутому: візуально прихований input не має
                  ловити фокус із клавіатури (як кнопки згорнутих блоків чек-іну). */}
              <TimeField
                label="Початок тихих годин"
                value={settings.quiet.from}
                onChange={(from) => saveQuiet({ from })}
                tabIndex={settings.quiet.enabled ? 0 : -1}
              />
              <span className="text-tx3">–</span>
              <TimeField
                label="Кінець тихих годин"
                value={settings.quiet.to}
                onChange={(to) => saveQuiet({ to })}
                tabIndex={settings.quiet.enabled ? 0 : -1}
              />
            </div>
          </div>
        </div>
        {settings.quiet.enabled && settings.quiet.from === settings.quiet.to && (
          <p role="status" className="renewal-chart-note">
            Початок і кінець однакові — тихого проміжку немає. Зміни один із часів.
          </p>
        )}
      </Section>

      <Section title="ПІДКЛЮЧЕННЯ">
        {connectorRow(
          '📅',
          'Календар · перегляд',
          connectors.calendar,
          connectors.google && connectors.scopeKnown !== true,
        )}
        {connectorRow(
          '📆',
          'Календар · планування',
          connectors.calendarWrite === true,
          connectors.google && connectors.scopeKnown !== true,
        )}
        {connectorRow(
          '✉️',
          'Пошта Gmail',
          connectors.gmail,
          connectors.google && connectors.scopeKnown !== true,
        )}
        {connectorRow('🏦', 'Monobank', connectors.mono === true)}
        <p className="renewal-chart-note">
          Це стан налаштування та відомих дозволів, а не перевірка доступності сервісу. Останній час
          банківської звірки показано у фінансах. Ключі тут не вводяться.
        </p>
        {!connectors.google && (
          <p className="text-[11.5px] leading-snug text-tx3">
            Підключення Google потребує налаштування інтеграції.
          </p>
        )}
      </Section>

      <OperationsPanel />
      <MemoryPanel />

      <details className="renewal-card">
        <summary className="cursor-pointer font-semibold text-sm">
          Стан сервісів і діагностика
        </summary>
        <div className="mt-5">
          <WorkerQualityBlock />
        </div>
      </details>

      <Section title="БЛОКИ «СЬОГОДНІ» Й БРИФІНГУ">
        {MODULES.map((m, i) => {
          // Відсутність оверрайду = дефолт config.yml; для цих блоків там
          // enabled:true (інваріант закріплено тестом tests/config.test.ts).
          const on = settings.modules[m.id] ?? true;
          return (
            <div key={m.id} style={cascade(i, 35)}>
              <SettingRow
                icon={<span className="w-[22px] flex-none text-center text-[15px]">{m.icon}</span>}
                title={m.label}
              >
                <Switch label={m.label} checked={on} onChange={(next) => saveModule(m.id, next)} />
              </SettingRow>
            </div>
          );
        })}
        <p className="text-[11.5px] leading-snug text-tx3">
          Вимкнений блок ховається на «Сьогодні» й не потрапляє в наступний брифінг. «Новини» також
          зупиняють автоматичний збір; раніше зібрані матеріали залишаються доступними.
        </p>
      </Section>

      {/* Теми новин: приглушена тема не запитується взагалі — оркестратор ріже її
          з конфіга ДО звернення до NewsData, тобто економить і кредит, і стрічку. */}
      {topics.length > 0 && (
        <Section title="ТЕМИ НОВИН">
          {topics.map((t) => {
            const on = !muted.some((topic) => canonicalNewsTopic(topic) === t);
            return (
              <SettingRow
                key={t}
                icon={
                  <span className="w-[22px] flex-none text-center text-[15px]">
                    {topicEmoji(t)}
                  </span>
                }
                title={t}
              >
                <Switch
                  label={t}
                  checked={on}
                  onChange={(enabled) => save.mutate({ topic: { name: t, enabled } })}
                />
              </SettingRow>
            );
          })}
          <p className="text-[11.5px] leading-snug text-tx3">
            Вимкнені теми не потрапляють у стрічку й наступний збір новин. Їх можна повернути тут у
            будь-який момент.
          </p>
        </Section>
      )}

      <details className="renewal-card">
        <summary className="cursor-pointer font-semibold text-sm">
          Дані та історія видалення
        </summary>
        <div className="mt-5">
          <DeletionReceiptsBlock />
        </div>
      </details>

      <HomeScreenSection />

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
        Світанок · Mini App {appVersion}
        {!inTelegram() && ' · демо-режим'}
      </div>
    </div>
  );
}
