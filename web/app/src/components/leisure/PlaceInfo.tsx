import { z } from 'zod';
import { leisureDate, type LeisureItem } from '../../api/leisure.ts';
const price = z.object({
  currencyCode: z.string(),
  units: z.union([z.string(), z.number()]),
  nanos: z.number().optional(),
});
const range = z.object({ startPrice: price.optional(), endPrice: price.optional() });
export function PlaceInfo({ item, now }: { item: LeisureItem; now: string }) {
  const parsed = range.safeParse(item.placeDetails?.price_range);
  const label = (value: z.infer<typeof price> | undefined) => {
    if (!value) return null;
    const amount = Number(value.units) + (value.nanos ?? 0) / 1e9;
    if (!Number.isFinite(amount)) return null;
    try {
      return new Intl.NumberFormat('uk-UA', {
        style: 'currency',
        currency: value.currencyCode,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return null;
    }
  };
  const low = parsed.success ? label(parsed.data.startPrice) : null;
  const high = parsed.success ? label(parsed.data.endPrice) : null;
  const fetched = item.placeDetails?.fetched_at;
  return (
    <>
      {(low || high) && (
        <p className="leisure-secondary">
          Орієнтовні ціни Google: {[low, high].filter(Boolean).join(' — ')}. Це не точна сума вашого
          замовлення.
        </p>
      )}
      {typeof fetched === 'string' && (
        <p className="leisure-secondary">
          Дані закладу: {leisureDate(fetched)}
          {Date.parse(now) - Date.parse(fetched) > 7 * 86400000 ? ' · потребують оновлення' : ''}
        </p>
      )}
    </>
  );
}
