import { useState, type ReactNode } from 'react';
import type { LeisureItem, LeisureWorkspace } from '../../api/leisure.ts';
import { selectLeisureHighlights } from '../../../../core/leisure/selection.mjs';

/** Freeze the owner's offered IDs for this week; choosing a card does not refill the queue. */
export function FiniteLeisureDeck({
  data,
  items,
  scope,
  reviewing,
  useWeeklySet = true,
  children,
}: {
  data: LeisureWorkspace;
  items: LeisureItem[];
  scope: string;
  reviewing: boolean;
  useWeeklySet?: boolean;
  children: (items: LeisureItem[]) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(reviewing);
  const [ids] = useState<string[]>(() => {
    const key = 'svitanok-leisure-shortlist:' + data.edition?.week + ':' + scope;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (Array.isArray(saved) && saved.every((v) => typeof v === 'string'))
        return saved.slice(0, 12);
    } catch {
      /* optional own-choice storage */
    }
    const selected = selectLeisureHighlights(
      items,
      [
        ...(data.discoveryDecisions ?? []).map((r) => ({ ...r, kind: 'discovery' })),
        ...data.records,
      ],
      data.settings,
      Date.parse(data.generatedAt),
    ).map((item) => item.id);
    try {
      if (selected.length) sessionStorage.setItem(key, JSON.stringify(selected));
    } catch {
      /* memory view still works */
    }
    return selected;
  });
  const offered =
    useWeeklySet && data.edition?.highlightIds?.length ? data.edition.highlightIds : ids;
  const selected = expanded
    ? items
    : selectLeisureHighlights(
        items.filter((item) => offered.includes(item.id)),
        [
          ...(data.discoveryDecisions ?? []).map((r) => ({ ...r, kind: 'discovery' })),
          ...data.records,
        ],
        data.settings,
        Date.parse(data.generatedAt),
      );
  return (
    <section
      className="leisure-finite-deck"
      aria-label={reviewing ? 'Повторний відбір' : 'Коротка добірка'}
    >
      {!reviewing && (
        <div className="leisure-shortlist-heading">
          <span className="leisure-eyebrow">
            {expanded ? 'Досліджуємо далі' : 'Нове для тебе цього тижня'}
          </span>
          <p className="leisure-secondary">
            {expanded
              ? 'Повний перелік відкрито за твоїм вибором.'
              : `До ${data.settings.selection.weeklyLimit} ідей загалом. Решта доступна в категоріях, коли захочеш.`}
          </p>
        </div>
      )}
      {children(selected)}
      {!expanded && items.some((item) => !offered.includes(item.id)) && (
        <button
          type="button"
          className="leisure-button leisure-explore-more"
          onClick={() => setExpanded(true)}
        >
          Хочу переглянути інші ідеї
        </button>
      )}
    </section>
  );
}
