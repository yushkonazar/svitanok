import type { LeisureItem, LeisureWorkspace } from '../../api/leisure.ts';
import { leisureDecisionIndex, leisureIdentity } from '../../../../core/leisure/identity.mjs';

export function selectionContext(data: LeisureWorkspace) {
  const decisions = leisureDecisionIndex(data.items, [
    ...(data.discoveryDecisions ?? []).map((r) => ({ ...r, kind: 'discovery' })),
    ...data.records,
  ]);
  return {
    decision: (item: LeisureItem) => decisions.get(item.identityKey ?? leisureIdentity(item)),
    known: (item: LeisureItem) =>
      !!data.knownPlaces[item.id]?.familiar ||
      data.records.some(
        (r) =>
          (r.kind === 'visit' && r.itemId === item.id) ||
          (r.kind === 'familiarity' &&
            !r.cleared &&
            (r.itemId === item.id ||
              (['food', 'place', 'trip'].includes(item.category) &&
                item.venueId &&
                r.venueId === item.venueId))),
      ),
  };
}
export type BrowseProps = {
  data: LeisureWorkspace;
  items: LeisureItem[];
  busy: boolean;
  onOpen: (item: LeisureItem) => void;
  onChoose: (
    item: LeisureItem,
    choice: 'interested' | 'priority' | 'uninterested' | 'clear',
  ) => void;
  onVisit: (item: LeisureItem) => void;
  onExplain: (item: LeisureItem) => void;
};
export function foodCuisine(item: LeisureItem) {
  const type =
    item.placeType + ' ' + ((item.placeDetails?.types as string[] | undefined) ?? []).join(' ');
  return (
    (
      [
        ['japanese', 'Японська'],
        ['italian', 'Італійська'],
        ['georgian', 'Грузинська'],
        ['ukrainian', 'Українська'],
        ['chinese', 'Китайська'],
        ['seafood', 'Морепродукти'],
        ['vegetarian', 'Вегетаріанська'],
        ['vegan', 'Веганська'],
        ['pizza', 'Піца'],
        ['cafe|coffee', 'Кава й десерти'],
        ['bakery', 'Пекарня'],
        ['bar|pub', 'Бар'],
      ] as const
    ).find(([expression]) => new RegExp(expression).test(type))?.[1] ?? 'Кухню не уточнено'
  );
}
export function distanceFromCentre(item: LeisureItem) {
  const lat = Number(item.placeDetails?.lat ?? item.lat),
    lon = Number(item.placeDetails?.lon ?? item.lon);
  if (
    (item.placeDetails?.lat ?? item.lat) == null ||
    (item.placeDetails?.lon ?? item.lon) == null ||
    !Number.isFinite(lat + lon)
  )
    return null;
  const radians = (n: number) => (n * Math.PI) / 180;
  const a =
    Math.sin(radians(lat - 49.8419) / 2) ** 2 +
    Math.cos(radians(lat)) * Math.cos(radians(49.8419)) * Math.sin(radians(lon - 24.0316) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function foodPairRange(item: LeisureItem) {
  const range = item.placeDetails?.price_range as
    | {
        startPrice?: { units?: string | number; nanos?: number; currencyCode?: string };
        endPrice?: { units?: string | number; nanos?: number; currencyCode?: string };
      }
    | undefined;
  const amount = (value: NonNullable<typeof range>['startPrice']) =>
    value && value.currencyCode === 'UAH' && Number.isFinite(Number(value.units))
      ? Math.round((Number(value.units) + (value.nanos ?? 0) / 1e9) * 2)
      : null;
  return { min: amount(range?.startPrice), max: amount(range?.endPrice) };
}
