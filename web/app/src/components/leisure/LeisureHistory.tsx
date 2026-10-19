import { useState } from 'react';
import {
  categoryLabels,
  leisureDate,
  type LeisureItem,
  type LeisureVisit,
  type LeisureWorkspace,
} from '../../api/leisure.ts';
import { LeisureMedia } from './LeisureMedia.tsx';
export function LeisureHistory({
  data,
  items,
  visits,
  onOpen,
  onEdit,
  onReturn,
}: {
  data: LeisureWorkspace;
  items: LeisureItem[];
  visits: LeisureVisit[];
  onOpen: (id: string) => void;
  onEdit: (visit: LeisureVisit) => void;
  onReturn: (id: string) => void;
}) {
  const [shown, setShown] = useState(8);
  const groups = new Map<string, { item: LeisureItem; visits: LeisureVisit[] }>();
  for (const visit of visits) {
    const item = items.find((i) => i.id === visit.itemId);
    if (!item) continue;
    const key = item.category === 'cinema' ? item.id : (item.venueId ?? item.id);
    const group = groups.get(key) ?? { item, visits: [] };
    group.visits.push(visit);
    groups.set(key, group);
  }
  const rows = [...groups.values()];
  const impression = (visit: LeisureVisit) => (
    <div className="leisure-history-review" key={visit.id}>
      <p className="leisure-secondary">
        {visit.visitedOn ? leisureDate(visit.visitedOn) : 'Дата невідома'} ·{' '}
        {visit.rating === 'liked'
          ? 'Сподобалось'
          : visit.rating === 'disliked'
            ? 'Не сподобалось'
            : visit.rating === 'neutral'
              ? 'Нормально'
              : 'Без оцінки'}
      </p>
      {visit.reason && <p className="leisure-impression">{visit.reason}</p>}
      <button type="button" className="leisure-text-button" onClick={() => onEdit(visit)}>
        Уточнити враження
      </button>
    </div>
  );
  return (
    <div className="leisure-history">
      {rows.slice(0, shown).map(({ item, visits: history }) => {
        const known = data.knownPlaces[item.id],
          reaction = data.records.find((r) => r.kind === 'reaction' && r.itemId === item.id);
        return (
          <article key={item.id} className="leisure-history-entry">
            <div className="leisure-history-heading">
              <LeisureMedia item={item} variant="thumb" />
              <div>
                <div className="leisure-caption">{categoryLabels[item.category]}</div>
                <h3>{item.title}</h3>
                {!!item.media?.length && (
                  <p className="leisure-secondary">{item.media[0]?.credit || item.source}</p>
                )}
                <p className="leisure-secondary">
                  {known?.frequent ? 'Бували багато разів · ' : ''}
                  {item.category === 'cinema'
                    ? 'Переглядів: '
                    : item.category === 'podcast'
                      ? 'Прослуховувань: '
                      : 'Записаних відвідувань: '}
                  {history.length}
                </p>
              </div>
            </div>
            {impression(history[0]!)}
            {history.length > 1 && (
              <details className="leisure-history-past">
                <summary>Попередні враження · {history.length - 1}</summary>
                {history.slice(1).map(impression)}
              </details>
            )}
            <div className="leisure-actions">
              <button type="button" className="leisure-button" onClick={() => onOpen(item.id)}>
                {item.category === 'podcast' ? 'Відкрити випуск' : 'Відкрити місце'}
              </button>
              <button type="button" className="leisure-button" onClick={() => onReturn(item.id)}>
                {item.category === 'cinema'
                  ? 'Хочу переглянути ще'
                  : item.category === 'podcast'
                    ? 'Хочу послухати ще'
                    : 'Хочу повернутися'}
                {reaction?.kind === 'reaction' && reaction.revisit ? ' ✓' : ''}
              </button>
            </div>
          </article>
        );
      })}
      {rows.length > shown && (
        <button type="button" className="leisure-button" onClick={() => setShown((n) => n + 8)}>
          Ще місця з історії
        </button>
      )}
      {!rows.length && (
        <p className="leisure-secondary">
          Запиши перегляд чи відвідування свайпом униз. Тут залишаться дата, оцінка й текст
          враження.
        </p>
      )}
    </div>
  );
}
