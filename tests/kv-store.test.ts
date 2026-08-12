import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSettings,
  loadStats,
  loadState,
  loadLatest,
  loadBriefingForDate,
  loadAssistantHistory,
  putAssistantHistory,
  updateStats,
  loadAssistantPending,
  claimAssistantPending,
  // @ts-expect-error — JS-модуль Worker'а без типів.
} from '../web/kv-store.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { ASSISTANT_HISTORY_TTL_S } from '../web/assistant-memory-core.mjs';

/* Доступ до KV, витягнутий із worker.js (Фаза 5). Два інваріанти, які тут і
 * перевіряються, — це вся причина, чому цей шар узагалі існує:
 *
 *   1. Биття JSON НІКОЛИ не валить запит. Кожен читач має нейтральний дефолт —
 *      інакше один зіпсований ключ віддавав би власнику 500 замість дашборда.
 *   2. `stats` пишуть КІЛЬКА незалежних писарів (Mini App, голос із чату, три
 *      5-хвилинні крони), а KV не має CAS. Тому updateStats читає ДВІЧІ і, якщо
 *      між читаннями хтось устиг записати, застосовує той самий patch до
 *      свіжішої копії — замість тихо затерти чужі зміни. */

let kv: Map<string, string>;
let putOpts: Map<string, unknown>;
/** Хук «конкурентний писар»: спрацьовує МІЖ двома читаннями updateStats. */
let onSecondRead: (() => void) | null;

function env() {
  let reads = 0;
  return {
    BRIEFING: {
      get: async (k: string) => {
        if (k === 'stats' && ++reads === 2 && onSecondRead) onSecondRead();
        return kv.get(k) ?? null;
      },
      put: async (k: string, v: string, opts?: unknown) => {
        kv.set(k, v);
        putOpts.set(k, opts);
      },
    },
  };
}

beforeEach(() => {
  kv = new Map();
  putOpts = new Map();
  onSecondRead = null;
});

describe('читачі — биття JSON дає нейтральний дефолт, а не виняток', () => {
  it('порожній KV -> дефолти', async () => {
    const e = env();
    expect(await loadStats(e)).toEqual({});
    expect(await loadState(e)).toEqual({});
    expect(await loadLatest(e)).toEqual({});
    expect(await loadAssistantHistory(e)).toEqual({});
    expect(await loadAssistantPending(e)).toBeNull();
    expect(await loadBriefingForDate(e, '2026-08-12')).toEqual({});
  });

  it('зіпсований JSON -> ті самі дефолти', async () => {
    for (const k of ['stats', 'state', 'latest', 'assistantHistory', 'assistantPending']) {
      kv.set(k, '{зламано');
    }
    const e = env();
    expect(await loadStats(e)).toEqual({});
    expect(await loadState(e)).toEqual({});
    expect(await loadAssistantPending(e)).toBeNull();
  });

  it('НЕ-обʼєкт у ключі (масив/рядок/null) теж дає дефолт', async () => {
    kv.set('state', '"рядок"');
    kv.set('assistantPending', 'null');
    expect(await loadState(env())).toEqual({});
    expect(await loadAssistantPending(env())).toBeNull();
  });

  it('loadSettings нормалізує будь-що — навіть биття (F2)', async () => {
    kv.set('settings', '{зламано');
    const s = await loadSettings(env());
    expect(s).toBeTruthy();
    expect(s.quiet).toBeDefined(); // дефолтна форма, а не undefined
  });

  it('історичний брифінг читається за датою', async () => {
    kv.set('briefing:2026-08-12', JSON.stringify({ blocks: [{ id: 'news' }] }));
    const b = await loadBriefingForDate(env(), '2026-08-12');
    expect(b.blocks[0].id).toBe('news');
  });
});

describe('updateStats — оптимістичний read-modify-write (KV не має CAS)', () => {
  it('без конкурента: patch застосовано один раз', async () => {
    kv.set('stats', JSON.stringify({ n: 1 }));
    const res = await updateStats(env(), (s: { n: number }) => ({ ...s, n: s.n + 1 }));
    expect(res).toEqual({ n: 2 });
    expect(JSON.parse(kv.get('stats')!)).toEqual({ n: 2 });
  });

  /* Реальний випадок із проду: власник тапнув «Ліг спати», вранці відкрив
     застосунок (авто-заповнення sleepH/bedtime), а крон, який почав читання ДО
     відкриття й дописав ПІСЛЯ, затер усе своєю до-заповнення копією. */
  it('конкурент устиг записати між читаннями -> patch іде на СВІЖУ копію, чуже не гине', async () => {
    kv.set('stats', JSON.stringify({ mine: 0 }));
    onSecondRead = () => kv.set('stats', JSON.stringify({ mine: 0, theirs: 'важливе' }));

    const res = await updateStats(env(), (s: Record<string, unknown>) => ({ ...s, mine: 1 }));

    expect(res).toEqual({ mine: 1, theirs: 'важливе' });
    expect(JSON.parse(kv.get('stats')!)).toEqual({ mine: 1, theirs: 'важливе' });
  });

  it('биття в ключі -> patch стартує з {}, запит не падає', async () => {
    kv.set('stats', '{зламано');
    const res = await updateStats(env(), (s: Record<string, unknown>) => ({ ...s, ok: true }));
    expect(res).toEqual({ ok: true });
  });
});

describe('пропозиція — списання double-tap-safe', () => {
  it('перший тап списує, другий уже ні (не виконуємо дію двічі)', async () => {
    kv.set('assistantPending', JSON.stringify({ id: 'ab12cd34', items: [] }));
    const e = env();
    expect(await claimAssistantPending(e, 'ab12cd34')).toBe(true);
    expect(await claimAssistantPending(e, 'ab12cd34')).toBe(false);
    expect(kv.get('assistantPending')).toBe('null'); // тумбстоун, не delete
  });

  it('чужий id не списує нічого', async () => {
    kv.set('assistantPending', JSON.stringify({ id: 'ab12cd34' }));
    expect(await claimAssistantPending(env(), 'ІНШИЙ')).toBe(false);
    expect(await loadAssistantPending(env())).toMatchObject({ id: 'ab12cd34' });
  });
});

describe('памʼять розмови — TTL стоїть в одному місці', () => {
  it('putAssistantHistory завжди пише з expirationTtl', async () => {
    await putAssistantHistory(env(), { '42:': [{ role: 'user', text: 'привіт' }] });
    expect(putOpts.get('assistantHistory')).toMatchObject({
      expirationTtl: ASSISTANT_HISTORY_TTL_S,
    });
    expect(await loadAssistantHistory(env())).toMatchObject({ '42:': [{ role: 'user' }] });
  });
});
