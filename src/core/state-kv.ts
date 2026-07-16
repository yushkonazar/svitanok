// KV-backed StateStore (§4.3 еволюція): стан у Cloudflare KV замість git-гілки
// `state` — атомарно, без rebase-конфліктів/гонок коміту. Читає/пише один JSON-
// блоб (namespace BRIEFING, ключ `state`) через CF API.
//
// Семантика at-least-once збережена (як у файловому state.ts): збій ЗАВАНТАЖЕННЯ
// -> порожній стан (можливий повтор — прийнятно); збій ЗАПИСУ -> throw (видимий
// failed-ран замість тихої втрати). KV має eventual consistency (~до 60с), але
// backup-schedule спрацьовує на години пізніше за точний CF-dispatch, тож гонка
// ідемпотентності практично неможлива.
//
// H2 (merge-before-flush): цей блоб пише ДВА незалежні писарі — оркестратор
// (тут) і Worker (web/worker.js: голоси, нагадування, roadmap, lastUpdateId,
// jobPrefs/mockWeights). Оркестратор тримає блоб у памʼяті ХВИЛИНАМИ (LLM-
// виклики), тож наївний PUT усього блоба на flush затирав би записи Worker,
// зроблені за цей час. Рішення: на flush перечитати СВІЖИЙ блоб і накласти
// ЛИШЕ ключі, які оркестратор реально змінив цього рану (`changed`) — per-key
// last-write-wins. Вікно гонки звужується з усього рану до GET→PUT (мс).
// Ключі, які оркестратор лише читав (jobPrefs/mockWeights) чи не чіпав,
// зберігаються зі свіжого блоба. KV не має CAS, тож залишковий мс-window і
// гонки Worker-vs-Worker — межа інструменту (стратегічний фікс — Durable Object).

import type { StateStore, Logger } from './types.js';
import type { Pruner } from './state.js';

type StateData = Record<string, unknown>;

/** Накласти змінені оркестратором ключі поверх свіжого блоба (per-key merge, H2). */
export function overlayChanged(
  fresh: StateData,
  mine: StateData,
  changed: Iterable<string>,
): StateData {
  const merged: StateData = { ...fresh };
  for (const k of changed) merged[k] = mine[k];
  return merged;
}

export interface KvStateOptions {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  key?: string;
  log?: Logger;
  pruners?: Pruner[];
  fetchImpl?: typeof fetch;
}

/** URL значення ключа в KV через CF API. */
function valueUrl(o: KvStateOptions, key: string): string {
  const acc = o.accountId.trim();
  const ns = o.namespaceId.trim();
  return `https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${ns}/values/${key}`;
}

/** Створити KV-стан: асинхронно завантажує наявний блоб, далі get/set/prune/flush. */
export async function createKvStateStore(opts: KvStateOptions): Promise<StateStore> {
  const f = opts.fetchImpl ?? fetch;
  const key = opts.key ?? 'state';
  const url = valueUrl(opts, key);
  const auth = { authorization: `Bearer ${opts.apiToken.trim()}` };
  const pruners = opts.pruners ?? [];
  let data: StateData = {};

  try {
    const resp = await f(url, { headers: auth });
    if (resp.ok) {
      const parsed: unknown = JSON.parse(await resp.text());
      if (parsed && typeof parsed === 'object') data = parsed as StateData;
    } else if (resp.status !== 404) {
      // 404 = ключа ще нема (перший запуск) — нормально, тихо.
      opts.log?.warn(`KV state: завантаження HTTP ${resp.status} — фолбек на порожній стан`);
    }
  } catch (e) {
    opts.log?.warn(
      `KV state: завантаження впало (${e instanceof Error ? e.message : String(e)}) — порожній стан`,
    );
  }

  let dirty = false;
  // Ключі, які цей ран реально змінив (для per-key merge на flush, H2).
  const changed = new Set<string>();

  return {
    get<T>(k: string): T | undefined {
      return data[k] as T | undefined;
    },
    set<T>(k: string, value: T): void {
      data[k] = value;
      changed.add(k);
      dirty = true;
    },
    prune(): void {
      if (pruners.length === 0) return;
      // Пруна чистить лише оркестратор-ексклюзивні агрегати (shownNews/
      // shownMail), які в типовому прогоні вже в `changed` через
      // set() свого модуля — тож окремо їх тут не позначаємо. Якщо модуль не
      // запускався, прунінг цього ключа відкладається до наступного разу
      // (housekeeping, не коректність) — не тягнемо його поверх свіжого блоба.
      for (const p of pruners) p(data);
      dirty = true;
    },
    async flush(): Promise<void> {
      if (!dirty) return;

      // Merge-before-flush (H2): перечитати свіжий блоб і накласти лише свої
      // змінені ключі, щоб не затерти записи Worker під час довгого рану.
      let fresh: StateData | null = null;
      try {
        const resp = await f(url, { headers: auth });
        if (resp.ok) {
          const parsed: unknown = JSON.parse(await resp.text());
          if (parsed && typeof parsed === 'object') fresh = parsed as StateData;
        } else if (resp.status !== 404) {
          // 404 = ключа ще нема (перший запис) -> пишемо повний блоб.
          opts.log?.warn(
            `KV state: re-read HTTP ${resp.status} перед merge — пишу свою копію повністю`,
          );
        }
      } catch (e) {
        opts.log?.warn(
          `KV state: re-read впав перед merge (${e instanceof Error ? e.message : String(e)}) — пишу свою копію повністю`,
        );
      }

      // fresh === null (404/збій re-read) -> фолбек на повний блоб (стара
      // поведінка: краще зберегти свій стан, ніж кинути). Інакше — per-key merge.
      const body = fresh ? overlayChanged(fresh, data, changed) : data;

      const resp = await f(url, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        // Видимий failed замість тихої втрати стану (§19.12).
        throw new Error(`KV state: запис HTTP ${resp.status} ${await resp.text()}`);
      }
      dirty = false;
      changed.clear();
    },
  };
}

/**
 * Прочитати довільний KV-ключ як JSON-обʼєкт (ТІЛЬКИ читання, без стану/флашу).
 * Для ключів, які оркестратор лише споживає, а пише хтось інший — сьогодні це
 * `settings` (тумблери модулів із Mini App, F2). Будь-який збій (404, HTTP,
 * мережа, биття JSON) -> null: відсутні налаштування мають означати «дефолти
 * config.yml», а не впалий ран брифінгу.
 */
export async function readKvJson(
  opts: KvStateOptions,
  key: string,
): Promise<Record<string, unknown> | null> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const resp = await f(valueUrl(opts, key), {
      headers: { authorization: `Bearer ${opts.apiToken.trim()}` },
    });
    if (resp.status === 404) return null; // ключа ще нема — нормально, тихо
    if (!resp.ok) {
      opts.log?.warn(`KV ${key}: читання HTTP ${resp.status} — ігнорую`);
      return null;
    }
    const parsed: unknown = JSON.parse(await resp.text());
    // Масив — теж typeof 'object', але це не блоб налаштувань: віддаємо null,
    // щоб споживач не діставав `.modules` з масиву.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (e) {
    opts.log?.warn(`KV ${key}: читання впало (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

/** Прочитати CF-креденшели зі змінних середовища; неповні -> null (локально файл). */
export function readKvEnv(): { accountId: string; apiToken: string; namespaceId: string } | null {
  const accountId = process.env.CF_ACCOUNT_ID?.trim();
  const apiToken = process.env.CF_API_TOKEN?.trim();
  const namespaceId = process.env.KV_NAMESPACE_ID?.trim();
  if (!accountId || !apiToken || !namespaceId) return null;
  return { accountId, apiToken, namespaceId };
}
