import { useState } from 'react';
import { useBriefing, useSettings } from '../../api/hooks.ts';
import {
  readBlock,
  newsDataSchema,
  type NewsGroup as NewsGroupT,
} from '../../api/briefing-schema.ts';
import { isReleaseTopic, topicKey } from '../../lib/topicKind.ts';
import { markTopicSeen } from '../../lib/newsSeen.ts';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { DigestCard } from './DigestCard.tsx';
import { TopicChipRow } from './TopicChipRow.tsx';
import { HeroNewsCard } from './HeroNewsCard.tsx';
import { CompactNewsCard } from './CompactNewsCard.tsx';
import { ReleaseGridSection } from './ReleaseGridSection.tsx';
import { MutedNewsTile } from './MutedNewsTile.tsx';
import { TopicSheet } from './TopicSheet.tsx';

// Вкладка «Новини» (редизайн: інтерактивні блоки замість рядків) — дайджест
// топ-подій зверху, сегмент 🌍 Світ/🇺🇦 Україна, ряд тем-чіпів (усі теми
// регіону, і приглушені теж — притлумлені), далі САМІ ТЕМИ у трьох формах:
//
//  1. Топ-N (ті самі теми, що потрапили в дайджест) — HeroNewsCard: повна
//     новина (джерело+час+заголовок+чому+❤️🔖 через NewsItem) + другий
//     айтем пік-рядком. Видно ОДРАЗУ, без тапу.
//  2. Релізи — ЗАВЖДИ окрема секція (незалежно від рангу): repo+версія+час,
//     ReleaseGridSection.
//  3. Решта — CompactNewsCard, 2-колонкова сітка: заголовок+джерела теж
//     видно одразу, тап -> повний Sheet.
//  4. Приглушені — MutedNewsTile, компактний сірий чіп, тапабельний (peek
//     без унмуту).
//
// Регіон-фільтр — той самий g.scope===scope, що й раніше: щойно тема без
// країни (Кіберспорт/Футбол/Релізи) отримала scope:'world' у config.yml,
// вона сама лишається лише в Світі, нічого зайвого фільтрувати не треба.

type Scope = 'world' | 'ua';

const SCOPES = [
  { id: 'world', label: '🌍 Світ' },
  { id: 'ua', label: '🇺🇦 Україна' },
] as const;

const HERO_COUNT = 3;

const NewsIcon = (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--color-tx3)"
    strokeWidth="1.6"
    strokeLinecap="round"
  >
    <path d="M3 12h5l2 3h4l2-3h5" />
    <path d="M4.5 8 6 4h12l1.5 4" />
    <path d="M3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
  </svg>
);

export function NewsScreen() {
  const [scope, setScope] = useState<Scope>('world');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = useBriefing();
  const { data: settings } = useSettings();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : 'Перевір з’єднання з мережею й спробуй ще раз.'
        }
        onRetry={() => refetch()}
      />
    );
  }

  const news = readBlock(data.brief.blocks, 'news', newsDataSchema);
  const allGroups = news?.groups ?? [];
  // Приглушені теми тут БІЛЬШЕ НЕ ховаємо (фідбек власника, редизайн) —
  // притлумлений чіп лишається тапабельним (peek без унмуту). Серверний
  // ефект (rss лишається у фетчі, newsdata — ріжеться) настає окремо, у
  // applyTopicMutes.
  const muted = new Set(settings?.settings.mutedTopics ?? []);
  const scoped = allGroups.filter((g) => g.scope === scope);
  const scopedUnmuted = scoped.filter((g) => !muted.has(g.topic));
  const scopedMuted = scoped.filter((g) => muted.has(g.topic));
  const openGroup = openKey ? (allGroups.find((g) => topicKey(g) === openKey) ?? null) : null;

  // Єдина брама відкриття теми (чіп/hero/compact/реліз-«показати всі»/муте-
  // тайл — усі йдуть сюди): позначає найновіший айтем теми як "переглянуто"
  // (items уже відсортовані бекендом за publishedAt) — це і гасить помаранчеве
  // кільце чіпа на сірий (фідбек власника, фото 2).
  const openTopic = (g: NewsGroupT) => {
    markTopicSeen(topicKey(g), (g.items[0] ?? g.more[0])?.url);
    setOpenKey(topicKey(g));
  };

  // Релізи — ЗАВЖДИ окрема секція, незалежно від ваги/рангу (версія — не
  // "новина", тож не має сенсу в топ-N/дайджесті). Решта — кандидати на
  // топ-N (Hero) чи compact.
  const releaseGroup = scopedUnmuted.find((g) => isReleaseTopic(g.topic)) ?? null;
  const newsGroups = scopedUnmuted.filter((g) => !isReleaseTopic(g.topic) && g.items.length > 0);
  const heroes = newsGroups.slice(0, HERO_COUNT);
  const compacts = newsGroups.slice(HERO_COUNT);

  // Дайджест — топ-N з УСІХ регіонів (не лише поточного scope), той самий
  // відбір, що дав heroes для активного регіону: групи вже відсортовані
  // бекендом за вагою спадно, тож перші НЕ приглушені/не-реліз групи й Є
  // "улюблене".
  const digestGroups = allGroups.filter((g) => !muted.has(g.topic) && !isReleaseTopic(g.topic));

  return (
    <div className="flex flex-col gap-4">
      <DigestCard groups={digestGroups} />

      <Segmented segments={SCOPES} value={scope} onChange={setScope} />

      {!news || !allGroups.length ? (
        <EmptyState
          icon={NewsIcon}
          title="Новин поки немає"
          text="На сьогодні стрічка порожня. Загляни пізніше або онови вручну."
          onReload={() => refetch()}
        />
      ) : scoped.length === 0 ? (
        <EmptyState
          icon={NewsIcon}
          title="У цій категорії порожньо"
          text="Тут поки нічого немає. Спробуй іншу категорію або онови."
          onReload={() => refetch()}
        />
      ) : (
        <>
          <TopicChipRow groups={scoped} muted={muted} onSelect={openTopic} />

          {heroes.map((g) => (
            <HeroNewsCard key={g.topic} group={g} onOpenAll={() => openTopic(g)} />
          ))}

          {releaseGroup && (
            <ReleaseGridSection group={releaseGroup} onOpenAll={() => openTopic(releaseGroup)} />
          )}

          {compacts.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5">
              {compacts.map((g) => (
                <CompactNewsCard key={g.topic} group={g} onOpen={() => openTopic(g)} />
              ))}
            </div>
          )}

          {scopedMuted.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {scopedMuted.map((g) => (
                <MutedNewsTile key={g.topic} group={g} onOpen={() => openTopic(g)} />
              ))}
            </div>
          )}
        </>
      )}

      {openGroup && <TopicSheet group={openGroup} onClose={() => setOpenKey(null)} />}
    </div>
  );
}
