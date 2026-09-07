// Вартість поїздки (S-5-6, ADR-033, етап 5 PR-4): авто рахує ядро з фактів
// (`facts.vehicle.<key>`: витрата л/100 км, пальне) × відстані `routes.eta`
// × ціни пального (`facts.setting.fuel_price`). Жодного числа з памʼяті
// моделі: немає факту - пункт лишається питанням до власника, а не
// «приблизно». Потяг/автобус/літак - ціна квитка від власника (S-5-7,
// Browser Rendering - окремий спайк).

import { runFactsGet } from '../tools/facts.mjs';
import { formatMoney } from '../format.mjs';

/** @typedef {{ key: string, name: string, per100: number | null, fuel: string | null }} Vehicle */

/**
 * Авто власника з фактів (ADR-033). Порожньо - список порожній, не помилка:
 * ланцюг спитає марку й витрату.
 * @param {Env} env
 * @returns {Promise<Vehicle[]>}
 */
export async function listVehicles(env) {
  const { result } = await runFactsGet(env, { kind: 'vehicle' });
  return /** @type {any[]} */ (result).map((r) => {
    const v = r.value ?? {};
    return {
      key: String(r.key),
      name: String(v.name ?? v.title ?? r.key),
      per100: Number.isFinite(Number(v.per100 ?? v.consumption))
        ? Number(v.per100 ?? v.consumption)
        : null,
      fuel: v.fuel == null ? null : String(v.fuel),
    };
  });
}

/** Ціна пального з `facts.setting.fuel_price` ({A95: 58.4} або число, грн/л). @param {Env} env @param {string | null} fuel */
export async function fuelPrice(env, fuel) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: 'fuel_price' });
  const value = /** @type {any} */ (result[0])?.value;
  if (value == null) return null;
  const raw =
    typeof value === 'number'
      ? value
      : ((fuel && value[fuel]) ?? value[String(fuel).toUpperCase()] ?? value.price ?? null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Пальне на поїздку в обидва боки: копійки + формула для власника.
 * @param {{ distanceM: number, per100: number, pricePerLiter: number, roundTrip?: boolean }} input
 */
export function fuelCost(input) {
  const km = (input.distanceM / 1000) * (input.roundTrip === false ? 1 : 2);
  const liters = (km * input.per100) / 100;
  const minor = Math.round(liters * input.pricePerLiter * 100);
  return {
    minor,
    km: Math.round(km),
    liters: Math.round(liters * 10) / 10,
    text: `${Math.round(km)} км × ${input.per100} л/100 км × ${input.pricePerLiter} грн = ${formatMoney(minor, 'UAH')} в обидва боки`,
  };
}

/**
 * Рядок вартості авто для блоку чекліста: усе відоме - число з формулою;
 * бракує множника - чесне питання, що саме сказати.
 * @param {{ vehicle: Vehicle | null, price: number | null, distanceM: number | null }} input
 */
export function carCostLine(input) {
  const missing = [];
  if (!input.vehicle) missing.push('яке авто (марка, витрата л/100 км, пальне)');
  else if (input.vehicle.per100 == null) missing.push(`витрату ${input.vehicle.name} (л/100 км)`);
  if (input.price == null) missing.push('ціну пального (грн/л)');
  if (input.distanceM == null) missing.push('маршрут (не порахував відстань)');
  if (missing.length) return `Вартість пального: бракує ${missing.join(', ')} - скажи, і порахую.`;
  const cost = fuelCost({
    distanceM: /** @type {number} */ (input.distanceM),
    per100: /** @type {number} */ (input.vehicle?.per100),
    pricePerLiter: /** @type {number} */ (input.price),
  });
  return `Пальне: ${cost.text}.`;
}
