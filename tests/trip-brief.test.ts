// trip.brief (ідея №4, п.1): ОДИН опитувальник на старті поїздки.
//
// Скарга власника дослівно: «поїздка у Івано-Франківськ 26.09, довелось
// уточнювати дату повернення, авто, час виїзду окремими повідомленнями».
// Тому головне тут - що перелік питань ПОВНИЙ з першого разу, а те, що ядро
// вже знає саме, у питання не потрапляє взагалі.

import { describe, it, expect } from 'vitest';
import { runTripBrief } from '../web/core/tools/trip.mjs';
import { TRIP_PURPOSES } from '../web/core/chains/trip.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-10T07:00:00.000Z');
const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0004_ideas_travel.sql'];

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) });
  return { env, db: d1.db };
}

const fields = (r: { ask: { field: string }[] }) => r.ask.map((a) => a.field);

describe('trip.brief', () => {
  it('питає ВСЕ разом - і дату повернення, і час виїзду, і авто', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(env, { to: 'Івано-Франківськ' });
    // ⚠️ Рівно ті поля, брак яких власник добирав окремими повідомленнями.
    expect(fields(result)).toEqual(
      expect.arrayContaining(['date_from', 'date_to', 'mode', 'depart_at', 'purpose']),
    );
    expect(result.then).toContain('ОДНЕ повідомлення');
  });

  it('що ядро знає саме - того не питає', async () => {
    const { env } = setup();
    await runFactsSet(
      env,
      { kind: 'vehicle', key: 'octavia', value: { name: 'Octavia', per100: 8, fuel: 'A95' } },
      NOW,
    );
    await runFactsSet(env, { kind: 'place', key: 'home', value: { city: 'Львів' } }, NOW);
    await runFactsSet(env, { kind: 'setting', key: 'fuel_price', value: { A95: 58.4 } }, NOW);
    const { result } = await runTripBrief(env, { to: 'Карпати', date_from: '2026-10-01' });
    // Дата вже названа, місто й авто відомі - у питаннях їх нема.
    expect(fields(result)).not.toContain('date_from');
    expect(fields(result)).not.toContain('from_city');
    expect(fields(result)).not.toContain('vehicle');
    // Авто йде списком варіантів із дефолтом, а не відкритим питанням.
    expect(result.ask.find((a: { field: string }) => a.field === 'vehicle_key')).toMatchObject({
      options: ['octavia'],
      default: 'octavia',
    });
    expect(result.known.from_city).toBe('Львів');
    expect(result.known.fuel_price).toBe(58.4);
  });

  it('авта ядро не знає - питає разом з рештою, а не окремим заходом', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(env, { to: 'Карпати' });
    expect(fields(result)).toContain('vehicle');
    expect(result.known.vehicles).toEqual([]);
  });

  it('мета вже названа - не перепитуємо', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(env, { to: 'Київ', purpose: 'ділова' });
    expect(fields(result)).not.toContain('purpose');
    expect(result.known.purpose).toBe('ділова');
    expect(result.purposes).toEqual(TRIP_PURPOSES);
  });

  it('вигадану мету не приймає - питає заново', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(env, { to: 'Київ', purpose: 'космос' });
    expect(fields(result)).toContain('purpose');
    expect(result.known.purpose).toBeNull();
  });

  it('без «куди» - чесна помилка', async () => {
    const { env } = setup();
    await expect(runTripBrief(env, { to: '  ' })).rejects.toThrow(/to/);
  });

  it('читання своїх фактів сесію не плямує', () => {
    // ⚠️ Опитувальник не ходить у мережу взагалі - плямувати нема чим, і
    // ✅ на наступну дію власника він коштувати не має.
    expect(TOOLS['trip.brief']!.tainting).toBeFalsy();
  });
});
