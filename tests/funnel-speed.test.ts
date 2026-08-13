import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';

/* Швидкість воронки.
 *
 * ⚠️ ПРОГАЛИНА, яку це закриває. Блок «Ритм» відповідав лише на «скільки»:
 * конверсії у відсотках, тижнева ціль, два тренди. Питання «а СКІЛЬКИ ЦЕ
 * ТРИВАЄ» і «що лежить без руху» не мало відповіді ніде — при тому, що дані
 * для неї збираються давно: funnelMeta[url].history пише {stage, ts} на кожній
 * реальній зміні стадії, і цей журнал уже їде в /api/stats заради «Історії» у
 * шторці вакансії. Тобто бракувало не даних, а їх зведення.
 *
 * Для того, хто шукає роботу, це найпрактичніше з усього блоку: «подав 12 днів
 * тому й тиша» — привід написати, а не чекати далі. */

const TODAY = '2026-08-13';
const back = (n: number) => {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Провести вакансію стадіями: [стадія, скільки діб тому]. */
const job = (s: unknown, url: string, path: [string, number][], title = 'Вакансія') => {
  let st = s;
  for (const [stage, daysAgo] of path) {
    st = recordEvent(st, { type: 'job_stage', url, stage, title }, back(daysAgo));
  }
  return st;
};

const speedOf = (s: unknown) => aggregateStats(s, TODAY).funnelSpeed;

describe('funnelSpeed — скільки триває кожен крок', () => {
  it('медіана діб між стадіями рахується з журналу переходів', () => {
    let s = emptyStore();
    // Три вакансії: подача через 2, 4 і 6 діб після збереження.
    s = job(s, 'a', [
      ['saved', 20],
      ['applied', 18],
    ]);
    s = job(s, 'b', [
      ['saved', 20],
      ['applied', 16],
    ]);
    s = job(s, 'c', [
      ['saved', 20],
      ['applied', 14],
    ]);
    const step = speedOf(s).steps.find((x: { to: string }) => x.to === 'applied');
    expect(step.n).toBe(3);
    expect(step.medianDays).toBe(4);
  });

  it('замало переходів -> медіани НЕМАЄ, лише лічильник', () => {
    let s = emptyStore();
    s = job(s, 'a', [
      ['saved', 10],
      ['applied', 8],
    ]);
    const step = speedOf(s).steps.find((x: { to: string }) => x.to === 'applied');
    expect(step.n).toBe(1);
    expect(step.medianDays).toBeNull();
  });

  it('стрибок через стадію не вигадує проміжного кроку', () => {
    // saved -> interview напряму (буває: подався поза застосунком).
    let s = emptyStore();
    s = job(s, 'a', [
      ['saved', 10],
      ['interview', 5],
    ]);
    const applied = speedOf(s).steps.find((x: { to: string }) => x.to === 'applied');
    expect(applied.n).toBe(0);
  });

  it('рух НАЗАД у воронці не рахується як крок уперед', () => {
    let s = emptyStore();
    s = job(s, 'a', [
      ['saved', 20],
      ['applied', 15],
      ['saved', 10],
      ['applied', 5],
    ]);
    const step = speedOf(s).steps.find((x: { to: string }) => x.to === 'applied');
    // Два переходи saved->applied: 5 діб і 5 діб. Відкат сам по собі — не крок.
    expect(step.n).toBe(2);
    // ...і на двох спостереженнях медіани все одно немає — гейт не обходиться
    // тим, що переходи «свої». Два правила діють разом, а не по черзі.
    expect(step.medianDays).toBeNull();
  });

  it('після відкату відлік починається ЗАНОВО, від дати відкату', () => {
    let s = emptyStore();
    // Три вакансії з відкатом: у кожної другий підхід тривав 5 діб.
    for (const url of ['a', 'b', 'c']) {
      s = job(s, url, [
        ['saved', 40],
        ['applied', 30],
        ['saved', 10],
        ['applied', 5],
      ]);
    }
    const step = speedOf(s).steps.find((x: { to: string }) => x.to === 'applied');
    expect(step.n).toBe(6);
    // Перший підхід — 10 діб, другий — 5. Медіана шести значень (по три
    // кожного) — 7.5; головне, що другий підхід НЕ рахується від першого
    // збереження (це дало б 35 діб і зіпсувало б усю оцінку).
    expect(step.medianDays).toBeLessThan(11);
  });

  it('порожня воронка -> кроки є, але всі нульові, і це не виняток', () => {
    const sp = speedOf(emptyStore());
    expect(sp.steps.map((x: { to: string }) => x.to)).toEqual(['applied', 'interview', 'offer']);
    for (const st of sp.steps) expect(st.n).toBe(0);
  });
});

describe('funnelSpeed — що лежить без руху', () => {
  it('активна вакансія без руху довше за поріг потрапляє в список', () => {
    const s = job(emptyStore(), 'a', [['saved', 40]], 'Стара');
    const sp = speedOf(s);
    expect(sp.stale).toHaveLength(1);
    expect(sp.stale[0]).toMatchObject({ url: 'a', stage: 'saved', title: 'Стара', days: 40 });
  });

  it('свіжа вакансія не потрапляє', () => {
    const s = job(emptyStore(), 'a', [['saved', 2]]);
    expect(speedOf(s).stale).toEqual([]);
  });

  it('дні рахуються від ОСТАННЬОГО руху, а не від входу у воронку', () => {
    // У воронці 40 діб, але стадію змінили 3 доби тому — це рух, не застій.
    const s = job(emptyStore(), 'a', [
      ['saved', 40],
      ['applied', 3],
    ]);
    expect(speedOf(s).stale).toEqual([]);
  });

  it('термінальні стадії не «лежать без руху» — там уже нічого не чекають', () => {
    let s = job(emptyStore(), 'a', [
      ['saved', 60],
      ['rejected', 50],
    ]);
    s = job(s, 'b', [
      ['saved', 60],
      ['failed', 50],
    ]);
    s = job(s, 'c', [
      ['saved', 60],
      ['offer', 50],
    ]);
    expect(speedOf(s).stale).toEqual([]);
  });

  it('найдовші — першими: список читають згори', () => {
    let s = job(emptyStore(), 'a', [['saved', 30]]);
    s = job(s, 'b', [['saved', 60]]);
    s = job(s, 'c', [['applied', 45]]);
    expect(speedOf(s).stale.map((x: { url: string }) => x.url)).toEqual(['b', 'c', 'a']);
  });

  it('легасі-запис без journal не валить агрегат', () => {
    const s = emptyStore();
    s.funnel['x'] = 'applied';
    s.funnelMeta['x'] = { title: 'Стара', ts: back(50) };
    expect(() => speedOf(s)).not.toThrow();
    // ts — єдине, що є; від нього й рахуємо.
    expect(speedOf(s).stale[0]).toMatchObject({ url: 'x', days: 50 });
  });

  it('поріг оголошений у відповіді — підпис не має його вгадувати', () => {
    expect(speedOf(emptyStore()).staleAfterDays).toBeGreaterThan(0);
  });
});
