// KV-backed StateStore (§4.3 еволюція): стан у Cloudflare KV замість git-гілки
// `state` — атомарно, без rebase-конфліктів/гонок коміту. Читає/пише один JSON-
// блоб (namespace BRIEFING, ключ `state`) через CF API.
//
// Семантика at-least-once збережена (як у файловому state.ts): збій ЗАВАНТАЖЕННЯ
// -> порожній стан (можливий повтор — прийнятно); збій ЗАПИСУ -> throw (видимий
// failed-ран замість тихої втрати). KV має eventual consistency (~до 60с), але
// backup-schedule спрацьовує на години пізніше за точний CF-dispatch, тож гонка
// ідемпотентності практично неможлива.

import type { StateStore, Logger } from './types.js';
import type { Pruner } from './state.js';

type StateData = Record<string, unknown>;

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

  return {
    get<T>(k: string): T | undefined {
      return data[k] as T | undefined;
    },
    set<T>(k: string, value: T): void {
      data[k] = value;
      dirty = true;
    },
    prune(): void {
      if (pruners.length === 0) return;
      for (const p of pruners) p(data);
      dirty = true;
    },
    async flush(): Promise<void> {
      if (!dirty) return;
      const resp = await f(url, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!resp.ok) {
        // Видимий failed замість тихої втрати стану (§19.12).
        throw new Error(`KV state: запис HTTP ${resp.status} ${await resp.text()}`);
      }
      dirty = false;
    },
  };
}

/** Прочитати CF-креденшели зі змінних середовища; неповні -> null (локально файл). */
export function readKvEnv(): { accountId: string; apiToken: string; namespaceId: string } | null {
  const accountId = process.env.CF_ACCOUNT_ID?.trim();
  const apiToken = process.env.CF_API_TOKEN?.trim();
  const namespaceId = process.env.KV_NAMESPACE_ID?.trim();
  if (!accountId || !apiToken || !namespaceId) return null;
  return { accountId, apiToken, namespaceId };
}
