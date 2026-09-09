// trip.brief (ідея №4, пункт 1): ОДИН опитувальник на старті поїздки.
//
// ⚠️ НАВІЩО ЦЕ ІНСТРУМЕНТ, А НЕ ПРАВИЛО В ПЕРСОНІ. Скарга власника дослівно:
// «поїздка у Івано-Франківськ 26.09, довелось уточнювати дату повернення, авто,
// час виїзду окремими повідомленнями». Прохання в промпті «спитай усе одразу»
// цього не лікує: модель не знає, ЯКІ саме поля потрібні ланцюгу, і дізнається
// про брак кожного по черзі - від помилки `chain.start`. Тут перелік полів
// рахує ядро з того самого джерела, що й валідація старту, і заразом підставляє
// все, що вже знає саме: авто з `facts.vehicle`, дім, ціну пального.
//
// Другий бік того самого: `purpose`. Ділова поїздка й транзит не потребують
// рекомендацій закладів - питати про них означає витрачати увагу власника на
// те, чого він не просив.

import { TRIP_MODES, TRIP_PURPOSES } from '../chains/trip.mjs';
import { listVehicles, fuelPrice } from '../trips/cost.mjs';
import { runFactsGet } from './facts.mjs';

/** Виїзд, якщо власник не назве години - той самий дефолт, що в ланцюгу. */
const DEFAULT_DEPART = '09:00';

/**
 * Що ще треба спитати, щоб стартувати ланцюг поїздки одним заходом.
 *
 * Повертає рівно три речі: `ask` - питання, які лишились; `known` - те, що ядро
 * підставить саме; `then` - що станеться далі. Модель має скласти з `ask` ОДНЕ
 * повідомлення, а не листування.
 * @param {Env} env
 * @param {{ to?: string, date_from?: string, purpose?: string }} args
 */
export async function runTripBrief(env, args) {
  const to = String(args.to ?? '').trim();
  if (!to) throw new Error('to обовʼязковий - куди їдемо');
  const purpose = TRIP_PURPOSES.includes(String(args.purpose ?? '')) ? String(args.purpose) : null;

  const [vehicles, home] = await Promise.all([listVehicles(env), homeCity(env)]);
  const price = await fuelPrice(env, vehicles[0]?.fuel ?? null);

  /** @type {{ field: string, question: string, options?: string[], default?: string }[]} */
  const ask = [];
  if (!args.date_from) ask.push({ field: 'date_from', question: 'Коли виїзд (дата)?' });
  // ⚠️ Дата повернення - ОКРЕМИМ питанням, а не «як буде». Саме її власнику
  // довелось уточнювати вручну, і без неї ланцюг не знає, скільки днів готувати.
  ask.push({ field: 'date_to', question: 'Коли назад? Якщо одним днем - так і скажи.' });
  ask.push({ field: 'mode', question: 'Чим їдемо?', options: TRIP_MODES });
  if (vehicles.length > 0) {
    ask.push({
      field: 'vehicle_key',
      question: 'Яким авто?',
      options: vehicles.map((v) => v.key),
      default: vehicles[0]?.key,
    });
  } else {
    // Авто ядро не знає - питаємо разом із рештою, а не окремим заходом потім.
    ask.push({
      field: 'vehicle',
      question: 'Якщо авто - марка, витрата (л/100 км) і пальне; запишу як факт.',
    });
  }
  ask.push({
    field: 'depart_at',
    question: 'О котрій виїзд?',
    default: DEFAULT_DEPART,
  });
  // ⚠️ Питаємо ЛИШЕ якщо дім не відомий у жодній формі (ревʼю). Ланцюг і сам
  // резолвить 'home' через координати, тож питання про місто виїзду при
  // відомому домі - рівно та зайвина, яку цей інструмент мав прибрати.
  if (!home.known) ask.push({ field: 'from_city', question: 'Звідки виїзд (місто)?' });
  ask.push({ field: 'country', question: 'Це закордон? Якщо так - яка країна?' });
  if (!purpose) {
    ask.push({ field: 'purpose', question: 'Мета поїздки?', options: TRIP_PURPOSES });
  }
  ask.push({ field: 'participants', question: 'Хто їде, крім тебе?' });

  return {
    result: {
      to,
      ask,
      known: {
        from_city: home.city,
        vehicles: vehicles.map((v) => ({ key: v.key, name: v.name, per100: v.per100 })),
        fuel_price: price,
        depart_at: DEFAULT_DEPART,
        date_from: args.date_from ?? null,
        purpose,
      },
      purposes: TRIP_PURPOSES,
      // Прямо кажемо моделі, що робити з відповідями: інакше вона знову піде
      // питати по одному, вже маючи перелік.
      then: 'склади ОДНЕ повідомлення з усіх ask, дочекайся відповідей і поклич chain.start(trip) один раз',
    },
  };
}

/**
 * Дім: чи відомий узагалі і як він зветься.
 *
 * ⚠️ Форм три, і ядро знає всі (ревʼю): `{city}` / `{name}`, канонічна
 * `{lat, lon}` (саме її радить `resolveHome`) і фолбек `OWNER_LOCATIONS`. Дві
 * останні дому НЕ називають - і це нормально: ланцюг усе одно бере координати
 * сам. Повну адресу як «місто» не віддаємо: вона поїхала б у `chain.start` і
 * рендерилась як «вул. Франка 24, Львів → Івано-Франківськ».
 * @param {Env} env
 * @returns {Promise<{ known: boolean, city: string | null }>}
 */
async function homeCity(env) {
  const { result } = await runFactsGet(env, { kind: 'place', key: 'home' });
  const value = /** @type {any} */ (result[0])?.value;
  if (value != null) {
    const named = value.city ?? value.name ?? null;
    const located = Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lon));
    if (named != null) return { known: true, city: String(named).slice(0, 60) };
    if (located || value.address != null) return { known: true, city: null };
  }
  try {
    const list = JSON.parse(String(env.OWNER_LOCATIONS ?? '[]'));
    const first = Array.isArray(list) ? list[0] : null;
    if (first)
      return { known: true, city: first.name == null ? null : String(first.name).slice(0, 60) };
  } catch {
    // Зіпсований OWNER_LOCATIONS - не привід валити опитувальник: просто
    // спитаємо місто, як і без нього.
  }
  return { known: false, city: null };
}
