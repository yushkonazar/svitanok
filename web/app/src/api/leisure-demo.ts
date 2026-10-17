import { leisureWorkspaceSchema, type LeisureWorkspace, type LeisureCommand } from './leisure.ts';
import { leisurePreferenceProfile, rankLeisureItems } from '../../../core/leisure/discovery.mjs';

let demo: LeisureWorkspace | null = null;
export function resetLeisureDemo() {
  demo = null;
}
export function readLeisureDemo(): LeisureWorkspace {
  if (demo) return structuredClone(demo);
  const today = new Date().toISOString().slice(0, 10),
    now = new Date().toISOString();
  const base = {
    venueId: null,
    placeId: null,
    lat: null,
    lon: null,
    startAt: null,
    endAt: null,
    status: 'available',
    registration: false,
    hours: '',
    studentNote: '',
    sessions: [],
    checkedAt: now,
    startDate: today,
    endDate: null,
    durationMinutes: null,
    genre: '',
    age: '',
  };
  const price = (min: number | null, basis = 'person') => ({
    min,
    max: null,
    currency: 'UAH',
    basis,
    note: '',
  });
  const items = [
    {
      ...base,
      id: 'demo-exhibition',
      category: 'exhibition',
      title: 'Ехо повертаючи вчуваючи ехо',
      summary: 'Звукова виставка про українську культуру. Демонстраційний приклад.',
      venue: 'Музей Міста',
      address: 'Львів, площа Ринок, 1',
      source: 'Lviv.travel',
      sourceUrl: 'https://lviv.travel/ua/events/vystavka-ekho-povertaiuchy-vchuvaiuchy-ekho-lviv',
      price: price(0),
      registration: true,
      venueId: 'demo-museum',
    },
    {
      ...base,
      id: 'demo-food',
      category: 'food',
      title: 'Трапезна Ідей',
      summary: 'Галицька кухня. Можна додати вечерю після виставки.',
      venue: 'Трапезна Ідей',
      venueId: 'demo-trapezna',
      address: 'Львів, Валова, 18а',
      source: 'Сайт закладу',
      sourceUrl: 'https://www.museideas.com/restaurant',
      price: price(null),
      hours: 'Пн–чт 11:00–21:00; пт–нд 11:00–22:00',
    },
    {
      ...base,
      id: 'demo-cinema',
      category: 'cinema',
      title: 'Кіновечір у Планеті кіно',
      summary: 'У демо не показуємо вигаданих сеансів. У Telegram тут буде актуальна афіша.',
      venue: 'Планета кіно',
      address: null,
      source: 'Планета кіно',
      sourceUrl: 'https://planetakino.ua/',
      status: 'schedule-pending',
      price: price(null),
    },
    {
      ...base,
      id: 'demo-trip',
      category: 'trip',
      title: 'Олеський замок',
      summary: 'Варіант поїздки машиною. Дорожні витрати окремо.',
      venue: 'Олеський замок',
      venueId: 'demo-olesko',
      address: 'Олесько, Замкова, 30',
      source: 'Львівська галерея мистецтв',
      sourceUrl: 'https://www.lvivgallery.org.ua/museums/muzey-zapovidnyk-oleskyy-zamok',
      price: price(200),
      studentNote: 'Для студентів — 150 ₴ за умовами музею.',
    },
  ];
  demo = leisureWorkspaceSchema.parse({
    version: 1,
    generatedAt: now,
    settings: {
      enabled: true,
      city: 'Львів',
      transport: 'car',
      updateHour: 8,
      categories: ['exhibition', 'festival', 'concert', 'show', 'cinema', 'food', 'trip'],
      cinemas: ['forum-lviv', 'king-cross'],
      students: 2,
      retention: 'until-deleted',
      telegram: false,
    },
    items,
    records: [],
    saved: [],
    historyLimit: 250,
    edition: {
      week: (() => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
        return date.toISOString().slice(0, 10);
      })(),
      until: (() => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 6 - ((date.getUTCDay() + 6) % 7));
        return date.toISOString().slice(0, 10);
      })(),
      ids: items.map((i) => i.id),
      futureIds: [],
      createdAt: now,
      reason: 'Демонстраційна добірка.',
      stale: false,
      sources: [],
      cinemaUpdatedAt: null,
    },
  });
  return structuredClone(demo);
}
export async function changeLeisureDemo(command: LeisureCommand) {
  const data = readLeisureDemo(),
    payload = command.payload,
    item = data.items.find((i) => i.id === command.id);
  let id: string | undefined;
  if (command.op === 'save' && item)
    data.saved = payload.saved
      ? [...new Set([...data.saved, item.id])]
      : data.saved.filter((v) => v !== item.id);
  if (command.op === 'settings') data.settings = { ...data.settings, ...payload };
  if (command.op === 'reaction' && item) {
    data.records = data.records.filter((r) => !(r.kind === 'reaction' && r.itemId === item.id));
    data.records.push({
      id: `reaction-${item.id}`,
      kind: 'reaction',
      revision: 1,
      itemId: item.id,
      venueId: item.venueId,
      verdict: String(payload.verdict),
      reasonCode: payload.reasonCode ? String(payload.reasonCode) : null,
      reason: String(payload.reason ?? ''),
      at: new Date().toISOString(),
    });
  }
  if (command.op === 'familiarity' && item) {
    const id = `familiarity-${item.venueId ?? item.id}`;
    const old = data.records.find((r) => r.id === id);
    data.records = data.records.filter((r) => r.id !== id);
    data.records.push({
      id,
      kind: 'familiarity',
      revision: (old?.revision ?? 0) + 1,
      itemId: item.id,
      venueId: item.venueId,
      title: item.title,
      mode: payload.mode as 'unknown' | 'many' | 'count' | 'clear',
      previousCount: payload.mode === 'count' ? Number(payload.previousCount) : null,
      trackingSince: new Date().toISOString(),
      cleared: payload.mode === 'clear',
    });
  }
  if (command.op === 'source-check' || command.op === 'place-check')
    return {
      receipt: {
        message: 'Демо: сайт і графік перевіряються в Telegram.',
        place: { hours: [], site: null, source: 'demo' },
      },
      workspace: data,
    };
  if (command.op === 'journey-check')
    return { receipt: { message: 'Демо: дорога не перевіряється.', legs: [] }, workspace: data };
  if (command.op === 'visit' && item) {
    const old = data.records.find((r) => r.id === payload.visitId && r.kind === 'visit');
    if (
      !old &&
      item.category === 'cinema' &&
      payload.visitedOn &&
      !payload.allowRepeat &&
      data.records.some(
        (r) => r.kind === 'visit' && r.itemId === item.id && r.visitedOn === payload.visitedOn,
      )
    )
      throw new Error('За цю дату вже є перегляд. Доповни збережений відгук.');
    id = old?.id ?? `visit-${command.commandId}`;
    data.records = data.records.filter((r) => r.id !== id);
    data.records.push({
      id,
      kind: 'visit',
      revision: (old?.revision ?? 0) + 1,
      itemId: item.id,
      venueId: item.venueId,
      category: item.category,
      title: item.title,
      visitedOn: payload.visitedOn ? String(payload.visitedOn) : null,
      rating: (payload.rating ?? null) as 'liked' | 'neutral' | 'disliked' | null,
      reason: String(payload.reason ?? ''),
      planId: payload.planId ? String(payload.planId) : null,
      legacy: payload.legacy === true,
    });
  }
  if (command.op === 'calendar-check')
    return {
      receipt: { message: 'Демо: календар не перевіряється.', available: false, conflicts: [] },
      workspace: data,
    };
  if (command.op === 'plan') {
    id = command.id ?? `plan-${command.commandId}`;
    const old = data.records.find((r) => r.id === id && r.kind === 'plan');
    const stops = (
      payload.stops as Array<{
        itemId: string;
        sessionId?: string;
        startAt: string;
        endAt: string;
        tickets?: boolean;
        reservation?: boolean;
      }>
    ).map((s) => {
      const i = data.items.find((v) => v.id === s.itemId)!;
      return {
        ...s,
        title: i.title,
        address: i.address,
        venueId: i.venueId,
        sourceUrl: i.sourceUrl,
        tickets: !!s.tickets,
        reservation: !!s.reservation,
      };
    });
    data.records = data.records.filter((r) => r.id !== id);
    data.records.push({
      id,
      kind: 'plan',
      revision: (old?.revision ?? 0) + 1,
      title: String(payload.title),
      estimatedBudgetMinor:
        payload.estimatedBudgetMinor == null ? null : Number(payload.estimatedBudgetMinor),
      stops,
      startAt: stops[0]!.startAt,
      endAt: stops.at(-1)!.endAt,
      status: 'planned',
      calendar: payload.calendar !== false,
      calendarState: 'none',
      calendarId: null,
    });
  }
  if (command.op === 'cancel' || command.op === 'outcome')
    data.records = data.records.map((r) =>
      r.id === command.id && r.kind === 'plan'
        ? {
            ...r,
            revision: r.revision + 1,
            status: command.op === 'cancel' ? 'cancelled' : (payload.status as 'went' | 'not-went'),
          }
        : r,
    );
  if (command.op === 'clear') {
    data.records = [];
    data.saved = [];
  }
  if (data.edition) {
    data.preferenceProfile = leisurePreferenceProfile(data.items, data.records, Date.now());
    data.edition.profileSignals = data.preferenceProfile.signals;
    data.edition.rankings = rankLeisureItems(
      data.items,
      data.records,
      [],
      data.settings,
      Date.now(),
    );
    data.edition.ids = data.edition.rankings.map((r) => r.id);
    data.knownPlaces = Object.fromEntries(data.edition.rankings.map((r) => [r.id, r.known]));
  }
  demo = leisureWorkspaceSchema.parse(data);
  return {
    receipt: {
      message: command.op === 'refresh' ? 'Демо не звертається до джерел.' : 'Збережено в демо.',
      ...(id ? { id } : {}),
    },
    workspace: structuredClone(demo),
  };
}
