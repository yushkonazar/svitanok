import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readLeisureDemo, resetLeisureDemo } from '../../api/leisure-demo.ts';
import type { LeisureItem, LeisureWorkspace } from '../../api/leisure.ts';
import { CategoryBrowse } from './CategoryBrowse.tsx';
import { FiniteLeisureDeck } from './FiniteLeisureDeck.tsx';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
beforeEach(() => {
  resetLeisureDemo();
  sessionStorage.clear();
});
function setup(mode: string, items: LeisureItem[], modify?: (data: LeisureWorkspace) => void) {
  const data = readLeisureDemo();
  data.items = items;
  data.generatedAt = '2026-10-22T08:00:00Z';
  modify?.(data);
  const callbacks = {
    onOpen: vi.fn(),
    onChoose: vi.fn(),
    onVisit: vi.fn(),
    onExplain: vi.fn(),
    onFollow: vi.fn(),
    onCorrect: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CategoryBrowse data={data} items={items} mode={mode} busy={false} {...callbacks} />
    </QueryClientProvider>,
  );
  return { data, ...callbacks };
}
describe('category-specific selection', () => {
  it('keeps a film independent of its cinema listings and offers one-click wishes', () => {
    const film = readLeisureDemo().items.find((i) => i.category === 'cinema')!;
    const { data, onChoose } = setup('cinema', [
      { ...film, identityKey: 'same-film' },
      { ...film, id: 'other-cinema', identityKey: 'same-film' },
    ]);
    expect(screen.getAllByRole('button', { name: /Деталі:/ })).toHaveLength(1);
    const browser = within(screen.getByRole('region', { name: 'Моя афіша' }));
    const article = within(browser.getByRole('article'));
    fireEvent.click(article.getByRole('button', { name: 'Хочу' }));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: film.id }), 'interested');
    expect(data.records).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps watched films in their own view without turning them into dislikes', () => {
    const film = readLeisureDemo().items.find((i) => i.category === 'cinema')!;
    setup('cinema', [film], (data) => {
      data.knownPlaces[film.id] = {
        familiar: true,
        frequent: false,
        previousCount: null,
        trackedCount: 1,
        legacyCount: 0,
        since: null,
      };
    });
    expect(screen.queryByRole('button', { name: 'Деталі: ' + film.title })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Дивився' }));
    expect(screen.getByRole('button', { name: 'Деталі: ' + film.title })).toBeInTheDocument();
  });
  it('groups performance dates under one production and allows a type correction', () => {
    const seed = readLeisureDemo().items[0]!;
    const show = {
      ...seed,
      category: 'show' as const,
      eventFormat: 'theatre',
      sourceUrl: 'https://example.com/production',
      startAt: '2026-10-24T15:00:00Z',
      startDate: '2026-10-24',
      endDate: '2026-10-24',
    };
    const { onCorrect } = setup('show', [
      show,
      {
        ...show,
        id: 'next-date',
        startAt: '2026-10-25T15:00:00Z',
        startDate: '2026-10-25',
        endDate: '2026-10-25',
      },
    ]);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByText('Дати цієї постановки · 2'));
    expect(screen.getByText(/25 жовтня/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Уточнити тип події' }));
    expect(onCorrect).toHaveBeenCalledWith(expect.objectContaining({ id: show.id }));
  });
  it('follows a podcast series separately from adding an episode to the queue', () => {
    const seed = readLeisureDemo().items[0]!;
    const episode = {
      ...seed,
      category: 'podcast' as const,
      podcast: { series: 'Розмови', publisher: 'Видавець', language: 'uk', explicit: false },
      publishedAt: '2026-10-21T08:00Z',
    };
    const { onFollow, onChoose } = setup('podcast', [episode]);
    fireEvent.click(screen.getByRole('button', { name: 'Стежити за серією' }));
    expect(onFollow).toHaveBeenCalledWith('Розмови');
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'У чергу' }));
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ id: episode.id }),
      'interested',
    );
  });
  it('keeps ended events out of discovery while retaining explicit wishes', () => {
    const seed = readLeisureDemo().items[0]!;
    const event = {
      ...seed,
      id: 'ended',
      category: 'exhibition' as const,
      title: 'Завершена виставка',
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      schedule: null,
    };
    setup('exhibition', [event], (data) => {
      data.records.push({
        id: 'reaction-ended',
        kind: 'reaction',
        itemId: event.id,
        venueId: event.venueId,
        verdict: 'interested',
        interestLevel: 'interested',
        reasonCodes: [],
        reasonCode: null,
        reason: '',
        revisit: false,
        snoozeUntil: null,
        revision: 1,
        at: '2026-10-01T08:00Z',
      });
    });
    expect(
      screen.queryByRole('button', { name: 'Деталі: ' + event.title }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Хочу', pressed: false }));
    expect(screen.getByRole('button', { name: 'Деталі: ' + event.title })).toBeInTheDocument();
    expect(screen.getByText('Покази або подія вже завершилися')).toBeInTheDocument();
  });
  it('freezes a short set instead of refilling it after each choice', () => {
    const data = readLeisureDemo();
    data.settings.selection.weeklyLimit = 4;
    const items = Array.from({ length: 16 }, (_, n) => ({
      ...data.items[0]!,
      id: 'idea-' + n,
      identityKey: 'identity-' + n,
      source: 'source-' + n,
      category: (n % 2 ? 'concert' : 'exhibition') as LeisureItem['category'],
    }));
    const view = render(
      <FiniteLeisureDeck data={data} items={items} scope="finite-test" reviewing={false}>
        {(selected) => (
          <div aria-label="selected">
            {selected.map((i) => (
              <span key={i.id}>{i.id}</span>
            ))}
          </div>
        )}
      </FiniteLeisureDeck>,
    );
    expect(screen.getByLabelText('selected').children).toHaveLength(4);
    const first = screen.getByLabelText('selected').firstElementChild!.textContent;
    view.rerender(
      <FiniteLeisureDeck
        data={data}
        items={items.filter((i) => i.id !== first)}
        scope="finite-test"
        reviewing={false}
      >
        {(selected) => (
          <div aria-label="selected">
            {selected.map((i) => (
              <span key={i.id}>{i.id}</span>
            ))}
          </div>
        )}
      </FiniteLeisureDeck>,
    );
    expect(screen.getByLabelText('selected').children).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Хочу переглянути інші ідеї' }));
    expect(screen.getByLabelText('selected').children).toHaveLength(15);
  });
});
