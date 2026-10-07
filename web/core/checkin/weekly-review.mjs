import { analyzeAdaptive, frequenciesV3 } from './adaptive-observations.mjs';
import { CHECKIN_CARDS_V3, FOLLOWUP_CARDS_V3, answerLabelV3 } from './adaptive.mjs';
import { shiftCheckinDate } from './observations.mjs';
/** Calendar weeks, matched weekdays for a partial current week, confirmed v3 answers only.
 * @param {KvBlob} records @param {string} today @param {boolean} [completed] */
export function weeklyReview(records, today, completed = true) {
  const weekday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const monday = shiftCheckinDate(today, -weekday - (completed ? 7 : 0));
  const to = completed ? shiftCheckinDate(monday, 6) : today;
  const days = completed ? 7 : weekday + 1;
  const a = analyzeAdaptive(records, to, days);
  const prior = analyzeAdaptive(records, shiftCheckinDate(to, -7), days);
  /** @type {{id:string,title:string,text:string,n:number,dates:string[]}[]} */ const items = [];
  const fmt = (/** @type {number} */ n) => n.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
  if (a.sleep.n >= 3)
    items.push({
      id: 'sleep',
      title: 'Тривалість сну',
      n: a.sleep.n,
      text:
        `У середньому ${fmt(a.sleep.value ?? 0)} год за ${a.sleep.n} записами.` +
        (prior.sleep.n >= 3
          ? ` Різниця з попереднім тижнем: ${fmt((a.sleep.value ?? 0) - (prior.sleep.value ?? 0))} год (${prior.sleep.n} записів).`
          : ' Для порівняння з попереднім тижнем ще мало відповідей.'),
      dates: a.current.filter((d) => d.sleepHours != null).map((d) => d.date),
    });
  const fields = new Map(
    [...Object.values(CHECKIN_CARDS_V3).flat(), ...FOLLOWUP_CARDS_V3]
      .flatMap((c) => c.fields)
      .map((f) => [f.id, f]),
  );
  /** @type {['morning'|'afternoon'|'evening',string,string][]} */ const explanations = [
    ['morning', 'sleepBlockersV3', 'Що заважало сну'],
    ['morning', 'bedtimeReasonsV3', 'Що відкладало відхід до сну'],
    ['morning', 'sleepHelpersV3', 'Що допомагало виспатися'],
    ['evening', 'developmentBlockersV3', 'Що заважало навчанню або читанню'],
  ];
  for (const [slot, key, title] of explanations) {
    const f = frequenciesV3(a.current, slot, key);
    const top = Object.entries(f.counts)
      .filter(([k]) => !['unknown', 'none', 'other'].includes(k))
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    if (f.n < 3 || !top || top[1] < 2) continue;
    const field = fields.get(key);
    if (!field) continue;
    items.push({
      id: key,
      title,
      n: f.n,
      text: `«${answerLabelV3(field, [top[0]])}» — у ${top[1]} з ${f.n} відповідей на це уточнення. Це твоя оцінка обставин, не доведена причина.`,
      dates: a.current.filter((d) => (d[slot][key] ?? []).includes(top[0])).map((d) => d.date),
    });
  }
  if (a.developmentAnswers >= 3)
    items.push({
      id: 'development',
      title: 'Час на розвиток',
      n: a.developmentAnswers,
      text:
        `Навчання — ${a.learning}, читання — ${a.reading} із ${a.developmentAnswers} вечірніх відповідей. Дні з обома заняттями входять у кожну цифру.` +
        (a.followThrough >= 3
          ? ` Ранковий план виконано у ${a.met} з ${a.followThrough} днів із відповідями вранці та ввечері.`
          : ''),
      dates: a.current.filter((d) => d.evening.developmentActualV3 != null).map((d) => d.date),
    });
  const pairs = a.current.filter(
    (d) => typeof d.morning.mood === 'number' && typeof d.evening.mood === 'number',
  );
  if (pairs.length >= 3)
    items.push({
      id: 'mood',
      title: 'Настрій від ранку до вечора',
      n: pairs.length,
      text: `Вищий увечері — ${pairs.filter((d) => d.evening.mood > d.morning.mood).length}, нижчий — ${pairs.filter((d) => d.evening.mood < d.morning.mood).length}, такий самий — ${pairs.filter((d) => d.evening.mood === d.morning.mood).length} із ${pairs.length} парних записів.`,
      dates: pairs.map((d) => d.date),
    });
  const order = [
    'sleep',
    'mood',
    'development',
    'bedtimeReasonsV3',
    'developmentBlockersV3',
    'sleepBlockersV3',
    'sleepHelpersV3',
  ];
  items.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  return { from: monday, to, days, recordedDays: a.recordedDays, items: items.slice(0, 5) };
}
