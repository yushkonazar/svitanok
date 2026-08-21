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
// withTimeout живе поруч із Google-викликами лише історично — це загальний
// abort-примітив, і calendar/mail беруть його звідти так само.
import { withTimeout } from './google-auth.js';

type StateData = Record<string, unknown>;

/**
 * Таймаут KV-виклику. Доти його не було ЗОВСІМ: CF API, що прийняв зʼєднання і
 * замовк, тримав прогін брифінгу до 360-хв ліміту job'а GitHub Actions — без
 * алерту, без падіння (B14). 15с із запасом покривають нормальний KV (десятки
 * мс), лишаючись далеко під бюджетом рану.
 */
export const KV_TIMEOUT_MS = 15_000;

/**
 * KV-виклик під таймаутом — разом ІЗ ТІЛОМ. Тіло читаємо завжди (і на помилці
 * теж): flush() кладе його в текст throw'а, а поза timed-регіоном воно було б
 * рівно тим самим зависанням, від якого й захищаємось.
 */
async function kvFetch(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  return withTimeout(async (signal) => {
    const resp = await f(url, { ...init, signal });
    return { ok: resp.ok, status: resp.status, text: await resp.text() };
  }, timeoutMs);
}

/**
 * Скільки разів пробуємо прочитати блоб, перш ніж визнати читання невдалим.
 *
 * ⚠️ Доти спроба була ОДНА, і будь-яке блимання мережі оберталось записом
 * повного блоба поверх свіжого (див. readBlob). Три спроби з лінійним бекофом
 * коштують у найгіршому разі 600 мс — мізер проти рану на хвилини, — і
 * прибирають найчастішу причину відмови (транзієнтний 5xx CF API).
 */
export const KV_READ_ATTEMPTS = 3;

/** База лінійного бекофу між спробами: 200 мс, далі 400 мс. */
const KV_RETRY_BASE_MS = 200;

/**
 * Результат читання блоба, де «немає ключа» і «не змогли прочитати» — РІЗНІ
 * стани.
 *
 * ⚠️ ЦЕ І Є ВИПРАВЛЕННЯ. Раніше обидва випадки давали `null`, і flush не міг
 * їх розрізнити: 404 (ключа ще нема) вимагає записати повний блоб, а 5xx/
 * таймаут/битий JSON — навпаки, забороняє писати будь-що, бо в KV лежить
 * свіжіший стан, якого ми не побачили. Одна відмова CF API під час нічного
 * рану затирала все, що Worker дописав за той час: чек-іни, нагадування,
 * голоси, roadmap.
 */
type ReadResult = { ok: true; value: StateData | null } | { ok: false; reason: string };

/**
 * Прочитати блоб із ретраями. 404 — це УСПІХ зі значенням null (ключа нема).
 * Будь-яка інша відмова після всіх спроб — { ok: false }, і вирішувати, що з
 * цим робити, мусить викликач.
 */
async function readBlob(
  f: typeof fetch,
  url: string,
  auth: Record<string, string>,
  timeoutMs: number,
  attempts: number,
  delayMs: number,
  log?: Logger,
): Promise<ReadResult> {
  let reason = 'unknown';
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs * i));
    try {
      const resp = await kvFetch(f, url, { headers: auth }, timeoutMs);
      if (resp.ok) {
        const parsed: unknown = JSON.parse(resp.text);
        return {
          ok: true,
          value: parsed && typeof parsed === 'object' ? (parsed as StateData) : null,
        };
      }
      // 404 — не помилка: ключа ще немає (перший запуск).
      if (resp.status === 404) return { ok: true, value: null };
      reason = `HTTP ${resp.status}`;
    } catch (e) {
      // Битий JSON сюди теж потрапляє — і це правильно: перезаписати
      // пошкоджений блоб «своєю копією» означало б добити те, що ще можна
      // врятувати руками.
      reason = e instanceof Error ? e.message : String(e);
    }
    if (i < attempts - 1) log?.warn(`KV state: читання не вдалось (${reason}) — спроба ${i + 2}`);
  }
  return { ok: false, reason };
}

/**
 * Накласти змінені оркестратором ключі поверх свіжого блоба (per-key merge, H2).
 *
 * Ключ із ТРАНСФОРМАЦІЄЮ (`state.update`) рахується тут заново, від свіжого
 * значення. Різниця не косметична: ран триває хвилини, і за цей час Worker
 * встигає записати в той самий блоб. `mine[k]` поклав би зверху значення,
 * пораховане на ПОЧАТКУ рану, тобто мовчки скасував би чужу зміну.
 */
export function overlayChanged(
  fresh: StateData,
  mine: StateData,
  changed: Iterable<string>,
  transforms: ReadonlyMap<string, (current: unknown) => unknown> = new Map(),
): StateData {
  const merged: StateData = { ...fresh };
  for (const k of changed) {
    const fn = transforms.get(k);
    merged[k] = fn ? fn(fresh[k]) : mine[k];
  }
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
  /** Стеля на КОЖЕН KV-виклик разом із читанням тіла (B14). */
  timeoutMs?: number;
  /** Пауза між спробами читання; 0 у тестах, щоб не спати даремно. */
  retryDelayMs?: number;
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
  const timeoutMs = opts.timeoutMs ?? KV_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? KV_RETRY_BASE_MS;
  let data: StateData = {};

  // Семантику завантаження лишаємо як була (збій -> порожній стан, можливий
  // повтор брифінгу — задокументований компроміс у шапці файлу), але тепер із
  // ретраями: одне блимання мережі більше не коштує цілого стану.
  //
  // ⚠️ `loadOk` памʼятає, чи ми взагалі бачили вміст. Це знадобиться на flush:
  // якщо завантаження впало, а re-read раптом каже 404, то це суперечність
  // (ключ щойно був), і писати «свою копію» в такий момент — найгірше з
  // можливого: у блобі лежить чужий стан, якого ми не прочитали ЖОДНОГО разу.
  const loaded = await readBlob(f, url, auth, timeoutMs, KV_READ_ATTEMPTS, retryDelayMs, opts.log);
  let loadOk = loaded.ok;
  if (loaded.ok) {
    if (loaded.value) data = loaded.value;
  } else {
    opts.log?.warn(`KV state: завантаження впало (${loaded.reason}) — порожній стан`);
  }

  let dirty = false;
  // Ключі, які цей ран реально змінив (для per-key merge на flush, H2).
  const changed = new Set<string>();
  // Ключі, змінені ТРАНСФОРМАЦІЄЮ: на flush рахуються від свіжого значення.
  const transforms = new Map<string, (current: unknown) => unknown>();

  return {
    get<T>(k: string): T | undefined {
      return data[k] as T | undefined;
    },
    set<T>(k: string, value: T): void {
      data[k] = value;
      changed.add(k);
      transforms.delete(k); // знімок перекриває раніший update на цьому ключі
      dirty = true;
    },
    update<T>(k: string, fn: (current: T | undefined) => T): void {
      data[k] = fn(data[k] as T | undefined);
      changed.add(k);
      transforms.set(k, (cur) => fn(cur as T | undefined));
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
      const read = await readBlob(
        f,
        url,
        auth,
        timeoutMs,
        KV_READ_ATTEMPTS,
        retryDelayMs,
        opts.log,
      );

      // ⚠️ НЕ ПИШЕМО НІЧОГО, якщо не змогли прочитати. Доти тут стояв фолбек
      // «краще зберегти свій стан, ніж кинути» — і саме він робив мережеве
      // блимання дорожчим за падіння рану: PUT повного блоба затирав усе, що
      // Worker дописав за хвилини роботи оркестратора.
      //
      // Ціна рішення названа прямо: flush фіксує lastSentDate ПІСЛЯ відправки
      // брифінгу, тож throw тут означає можливий ПОВТОР брифінгу наступного
      // рану. Це та сама at-least-once семантика, що вже описана в шапці файлу
      // для збою завантаження, і вона дешевша за втрату чек-інів і нагадувань:
      // зайве повідомлення видно й воно нічого не руйнує, а стерті дані —
      // назавжди.
      if (!read.ok) {
        throw new Error(
          `KV state: flush скасовано — не вдалось перечитати блоб (${read.reason}) за ${KV_READ_ATTEMPTS} спроб(и). Нічого не записано, щоб не затерти чужі записи.`,
        );
      }

      // Суперечність: завантаження впало, а тепер ключа «немає». Один із двох
      // відповідей CF API хибний, і писати повний блоб на такій підставі — це
      // перезаписати стан, якого ми не бачили жодного разу.
      if (read.value === null && !loadOk) {
        throw new Error(
          'KV state: flush скасовано — завантаження впало, а re-read віддав 404. Стан не читався жодного разу, повний запис затер би чужі дані.',
        );
      }

      // value === null тут означає ЧЕСНИЙ 404 при успішному завантаженні:
      // ключа справді немає (перший запис) -> пишемо повний блоб.
      const body = read.value ? overlayChanged(read.value, data, changed, transforms) : data;

      const resp = await kvFetch(
        f,
        url,
        {
          method: 'PUT',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      if (!resp.ok) {
        // Видимий failed замість тихої втрати стану (§19.12).
        throw new Error(`KV state: запис HTTP ${resp.status} ${resp.text}`);
      }
      dirty = false;
      changed.clear();
      // Після успішного PUT блоб напевно існує й ми знаємо його вміст — тож
      // наступний flush у цьому ж рані не мусить спотикатись об `loadOk`.
      loadOk = true;
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
    const resp = await kvFetch(
      f,
      valueUrl(opts, key),
      { headers: { authorization: `Bearer ${opts.apiToken.trim()}` } },
      opts.timeoutMs ?? KV_TIMEOUT_MS,
    );
    if (resp.status === 404) return null; // ключа ще нема — нормально, тихо
    if (!resp.ok) {
      opts.log?.warn(`KV ${key}: читання HTTP ${resp.status} — ігнорую`);
      return null;
    }
    const parsed: unknown = JSON.parse(resp.text);
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

/**
 * Записати JSON у довільний KV-ключ (best-effort — НІКОЛИ не throw, дзеркало
 * readKvJson). На відміну від flush() (де мовчазна втрата ВСЬОГО стану —
 * реальна проблема, throw навмисний), тут викликач сам зважує критичність:
 * для assistantPending (пропозиція листа-запрошення, orchestrator.ts) основний
 * брифінг уже надіслано — збій запису лише вимикає кнопки ✅/❌ під ним, не
 * валить увесь ран.
 */
export async function writeKvJson(
  opts: KvStateOptions,
  key: string,
  value: unknown,
): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const resp = await kvFetch(
      f,
      valueUrl(opts, key),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${opts.apiToken.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(value),
      },
      opts.timeoutMs ?? KV_TIMEOUT_MS,
    );
    if (!resp.ok) {
      opts.log?.warn(`KV ${key}: запис HTTP ${resp.status} — ігнорую`);
      return false;
    }
    return true;
  } catch (e) {
    opts.log?.warn(`KV ${key}: запис впав (${e instanceof Error ? e.message : String(e)})`);
    return false;
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
