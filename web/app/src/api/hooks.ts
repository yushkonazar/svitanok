import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { inTelegram } from '../telegram.ts';
import {
  fetchStats,
  fetchBriefing,
  fetchLiveWeather,
  fetchSettings,
  fetchSaved,
  postEvent,
  postSettings,
  postVote,
  setWeatherLocation,
  setWeatherLocationExact,
  clearWeatherLocation,
  suggestWeatherLocations,
  SAVED_PAGE,
  type StatsResult,
  type VoteDir,
} from './client.ts';
import type { SavedPage, CheckinSlot } from './schema.ts';
import type { WeatherSuggestion } from './briefing-schema.ts';
import { nextSavedOffset } from './paging.ts';
import type { SettingsPatch, SettingsResponse } from './settings-schema.ts';
import type { FunnelStage } from '../components/jobs/stages.ts';

// TanStack Query хуки даних дашборда (роадмеп v3, E1+E2). Дефолти (staleTime 60с,
// retry 1) — у main.tsx. Дві незалежні черги: ['brief'] (щоденний знімок) і
// ['stats'] (агрегат). Мутації чіпають ЛИШЕ ['stats'] — контент брифінгу не
// похідний від подій. Оптимістичне оновлення кешу дає миттєвий відгук і працює
// в демо (де postEvent — no-op, тож інвалідацію пропускаємо, щоб зміна лишилась).

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: fetchStats });
}

export function useBriefing() {
  return useQuery({ queryKey: ['brief'], queryFn: fetchBriefing });
}

/**
 * Жива погода (PR-7) — окрема, незалежна черга від ['brief']: снапшот брифінгу
 * лишається як фолбек (WeatherBlock отримує обидва, воліє живі дані). Worker
 * сам кешує на ~30 хв (спільний OpenWeather-ключ/квота з оркестратором), тож
 * 5-хвилинний refetchInterval здебільшого просто б'є в KV-кеш, не в OpenWeather.
 * retry:0 — fetchLiveWeather і так ніколи не кидає (null = «нема живих
 * даних», не помилка), ретраї лише додали б затримку до фолбеку.
 */
export function useLiveWeather() {
  return useQuery({
    queryKey: ['liveWeather'],
    queryFn: fetchLiveWeather,
    refetchInterval: 5 * 60_000,
    retry: 0,
  });
}

/** Встановити ручне перевизначення локації погоди (фідбек власника). На
 *  відміну від решти мутацій дашборда — БЕЗ оптимістичного оновлення: ім'я
 *  міста валідує OpenWeather (геокодування), тож локальне вгадування
 *  результату до відповіді сервера означало б показати щось, що потім
 *  довелось би тихо відкотити при 404. Просто чекаємо й інвалідуємо. */
export function useSetWeatherLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (city: string) => setWeatherLocation(city),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['liveWeather'] }),
  });
}

/** Те саме, але з ГОТОВИМ кандидатом з автозаповнення (обходить повторне
 *  геокодування — див. коментар у client.ts). */
export function useSetWeatherLocationExact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pick: Pick<WeatherSuggestion, 'lat' | 'lon' | 'name'>) =>
      setWeatherLocationExact(pick),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['liveWeather'] }),
  });
}

/** Прибрати ручне перевизначення -> повернутись до авто-детекції по IP. */
export function useClearWeatherLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clearWeatherLocation(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['liveWeather'] }),
  });
}

/**
 * Кандидати для автозаповнення (фідбек власника) — увімкнено лише коли
 * запит ≥2 символів (той самий поріг, що Worker: коротші префікси — шум).
 * Клієнт додатково дебаунсить ЗНАЧЕННЯ перед тим, як воно потрапляє сюди
 * (WeatherBlock), тож query fire відбувається не на кожен keystroke.
 */
export function useWeatherSuggestions(q: string) {
  return useQuery({
    queryKey: ['weatherSuggest', q],
    queryFn: () => suggestWeatherLocations(q),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    retry: 0,
  });
}

/** Оновити ['stats'] в кеші, зберігши обгортку StatsResult. */
function patchStats(
  qc: ReturnType<typeof useQueryClient>,
  fn: (s: StatsResult['stats']) => StatsResult['stats'],
) {
  qc.setQueryData<StatsResult>(['stats'], (old) =>
    old ? { ...old, stats: fn(old.stats) } : old,
  );
}

type SavedInfinite = { pages: SavedPage[]; pageParams: number[] };

/** Усе, що пише збережене, ходить по черзі — див. SAVED_SCOPE нижче. */
const SAVED_SCOPE = { id: 'saved-write' };

/**
 * Знімок обох черг перед оптимістичним записом + відкат.
 *
 * ⚠️ cancelQueries по ['saved'] ОБОВʼЯЗКОВИЙ: без нього запит, що вже в польоті
 * (перший фетч екрана або «Показати ще»), приземлиться ПІСЛЯ нашого патчу й
 * перезапише його своєю — ще дореміченою — відповіддю. Видалений рядок просто
 * повернеться. Те саме правило, що й для ['stats'] поруч.
 */
async function snapshotSaved(qc: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    qc.cancelQueries({ queryKey: ['stats'] }),
    qc.cancelQueries({ queryKey: ['saved'] }),
  ]);
  return {
    prev: qc.getQueryData<StatsResult>(['stats']),
    prevSaved: qc.getQueriesData<SavedInfinite>({ queryKey: ['saved'] }),
  };
}

type SavedSnapshot = Awaited<ReturnType<typeof snapshotSaved>>;

/** Повернути обидві черги як були (мутація впала). */
function restoreSaved(qc: ReturnType<typeof useQueryClient>, ctx: SavedSnapshot | undefined) {
  if (!ctx) return;
  if (ctx.prev) qc.setQueryData(['stats'], ctx.prev);
  // Без цього невдале видалення лишало б рядок ЗНИКЛИМ, хоч на сервері він є.
  for (const [key, data] of ctx.prevSaved) qc.setQueryData(key, data);
}

/**
 * Прибрати запис з УСІХ сторінок архіву ['saved'] (F-борг, екран «Збережене»).
 *
 * Тогли 🔖 патчили лише ['stats'], бо архіву-екрана ще не існувало — прев'ю з
 * 8 записів жило всередині статистики. Тепер видалення відбувається САМЕ на
 * екрані архіву, тож без цього рядок лишався б на місці до перезаходу.
 * setQueriesData (не setQueryData) — ключ містить сторінки, а вони нас не
 * обходять: чистимо скрізь, де запис трапиться.
 */
function dropFromSaved(
  qc: ReturnType<typeof useQueryClient>,
  match: (kind: string, id: string | null) => boolean,
): boolean {
  let hit = 0;
  qc.setQueriesData<SavedInfinite>({ queryKey: ['saved'] }, (old) => {
    if (!old) return old;
    let removed = 0;
    const pages = old.pages.map((p) => {
      const items = p.items.filter((x) => !match(x.kind, x.id));
      removed += p.items.length - items.length;
      return { ...p, items };
    });
    if (!removed) return old;
    hit += removed;
    return { ...old, pages: pages.map((p) => ({ ...p, total: Math.max(0, p.total - removed) })) };
  });
  // Повертаємо ФАКТ, а не «я старався»: викликач вирішує по цьому, чи зменшувати
  // savedCount. Збрехати «так» означало б віднімати лічильник і на повторному
  // тапі по вже видаленому.
  return hit > 0;
}

/**
 * Оцінка питання дня (😌 Легко / 😰 Важко).
 *
 * qId (F4) — ключ ідемпотентності на сервері: перша оцінка рахує тему й день,
 * зміна думки лише переставляє weak. Без нього кожен тап рахувався б наново.
 */
export function useMockAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { qId: string; topic: string; rating: 'easy' | 'hard' }) =>
      postEvent('mock_answer', vars),
    onMutate: async ({ qId, rating }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => ({
        ...s,
        mockRatedToday: true,
        mockRated: { ...s.mockRated, [qId]: rating },
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/** Тогл 🔖 для факту/цитати/питання (save_item / unsave_item). */
export function useToggleSaveItem() {
  const qc = useQueryClient();
  return useMutation({
    // scope — щоб два записи збереженого НЕ йшли паралельно: кожен /api/event
    // робить read-modify-write спільного блоба `stats`, а в KV немає CAS. Дві
    // одночасні відповіді -> та, що фінішувала другою, відкотить першу. Доти це
    // було майже недосяжно (🔖 тиснеш по одному), але екран «Збережене» дав
    // колонку хрестиків — швидкі видалення підряд тепер природна дія.
    scope: SAVED_SCOPE,
    mutationFn: (vars: { save: boolean; kind: string; id: string; title: string }) =>
      postEvent(vars.save ? 'save_item' : 'unsave_item', {
        kind: vars.kind,
        id: vars.id,
        title: vars.title,
      }),
    onMutate: async ({ save, kind, id, title }) => {
      const ctx = await snapshotSaved(qc);
      const dropped = !save && dropFromSaved(qc, (k, i) => k === kind && i === id);
      patchStats(qc, (s) => {
        const exists = s.savedList.some((x) => x.kind === kind && x.id === id);
        if (save) {
          if (exists) return s;
          return {
            ...s,
            savedCount: s.savedCount + 1,
            savedList: [{ kind, id, title, url: null, ts: '' }, ...s.savedList],
          };
        }
        return {
          ...s,
          // savedList — лише top-8 прев'ю, тож `exists` бреше про 9-й і далі:
          // видалення з архіву не зменшувало б лічильник узагалі. Рахуємо факт
          // видалення (з прев'ю АБО з архіву), а не наявність у прев'ю.
          savedCount: exists || dropped ? Math.max(0, s.savedCount - 1) : s.savedCount,
          savedList: s.savedList.filter((x) => !(x.kind === kind && x.id === id)),
        };
      });
      return ctx;
    },
    onError: (_e, _v, ctx) => restoreSaved(qc, ctx),
    onSettled: () => {
      if (inTelegram()) invalidateSaved(qc);
    },
  });
}

/**
 * Після зміни збереженого перетягуємо і агрегат, і архів.
 *
 * ['saved'] інвалідуємо цілком, а не патчимо далі: пагінація по offset після
 * видалення зсувається, тож єдина чесна відповідь — перепитати сервер. Для
 * infinite-черги TanStack перетягне всі вже набрані сторінки.
 */
function invalidateSaved(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['stats'] });
  qc.invalidateQueries({ queryKey: ['saved'] });
}

// ── E3: Новини + Вакансії ──

/**
 * ❤️ на новині. Оптимістично + звірка з авторитетним voted сервера.
 *
 * Напрямок більше НЕ параметр: дизлайків немає, лишився один сигнал (фідбек
 * власника, п.5). Тогл робить сервер (applyUrlVote: повторний той самий
 * напрямок = зняти), ми лише передбачаємо результат для миттєвого відгуку.
 */
export function useVote() {
  const qc = useQueryClient();
  return useMutation({
    // Лише запит; оптимістичне значення рахуємо в onMutate (де кеш ще НЕ змінено).
    mutationFn: (vars: { category: string; url: string }) => postVote(vars.category, vars.url),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      const cur = prev?.stats.votes?.[vars.url] ?? null;
      // Лайкнуте -> знімаємо; будь-що інше (зокрема легасі-'down') -> лайк.
      const optimistic: VoteDir = cur === 'up' ? null : 'up';
      setVote(qc, vars.url, optimistic);
      return { prev, optimistic };
    },
    onSuccess: (data, vars, ctx) => {
      // У Telegram — авторитетний voted сервера; у демо (data=null) — оптимістичний.
      setVote(qc, vars.url, data ? data.voted : (ctx?.optimistic ?? null));
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

function setVote(qc: ReturnType<typeof useQueryClient>, url: string, dir: VoteDir) {
  patchStats(qc, (s) => {
    const votes = { ...(s.votes ?? {}) };
    if (dir) votes[url] = dir;
    else delete votes[url];
    return { ...s, votes };
  });
}

/** Тогл 🔖 для новини (save_news / unsave_news; kind='news', id=url). */
export function useToggleSaveNews() {
  const qc = useQueryClient();
  return useMutation({
    scope: SAVED_SCOPE, // серіалізація записів — див. useToggleSaveItem
    mutationFn: (vars: { save: boolean; url: string; title: string; category: string }) =>
      postEvent(vars.save ? 'save_news' : 'unsave_news', {
        url: vars.url,
        title: vars.title,
        category: vars.category,
      }),
    onMutate: async ({ save, url, title }) => {
      const ctx = await snapshotSaved(qc);
      const dropped = !save && dropFromSaved(qc, (k, i) => k === 'news' && i === url);
      patchStats(qc, (s) => {
        const exists = s.savedList.some((x) => x.kind === 'news' && x.id === url);
        if (save) {
          if (exists) return s;
          return {
            ...s,
            savedCount: s.savedCount + 1,
            savedList: [{ kind: 'news', id: url, title, url, ts: '' }, ...s.savedList],
          };
        }
        return {
          ...s,
          // Див. useToggleSaveItem: savedList — лише top-8, тож саме прев'ю не
          // може бути мірилом того, чи запис існував.
          savedCount: exists || dropped ? Math.max(0, s.savedCount - 1) : s.savedCount,
          savedList: s.savedList.filter((x) => !(x.kind === 'news' && x.id === url)),
        };
      });
      return ctx;
    },
    onError: (_e, _v, ctx) => restoreSaved(qc, ctx),
    onSettled: () => {
      if (inTelegram()) invalidateSaved(qc);
    },
  });
}

/** Встановити/зняти стадію воронки для вакансії (job_stage; stage=null прибирає). */
export function useJobStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      url: string;
      title: string;
      // Єдине джерело правди про стадії — components/jobs/stages.ts (дзеркало
      // stats-core). Локальний union тут розʼїхався б із ним мовчки.
      stage: FunnelStage | null;
      fit?: number;
    }) =>
      postEvent('job_stage', {
        url: vars.url,
        title: vars.title,
        stage: vars.stage,
        ...(vars.fit != null ? { fit: vars.fit } : {}),
      }),
    onMutate: async ({ url, title, stage }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => {
        // Зберігаємо ts/title/history наявного запису — дзеркалимо сервер (F1):
        // ts там ставиться лише на ПЕРШОМУ вході й далі не змінюється, а журнал
        // накопичується. Затерти їх тут = показати неправду до рефетчу.
        const existing = s.funnelList.find((x) => x.url === url);
        let list = s.funnelList.filter((x) => x.url !== url);
        if (stage) {
          const history = existing?.history ?? [];
          list = [
            {
              url,
              stage,
              title: title || existing?.title || '',
              ts: existing?.ts ?? '',
              // Реальна зміна стадії -> новий запис у журналі (без дати: її знає
              // лише сервер, київський день). Повтор тієї ж стадії журнал не чіпає.
              history:
                existing?.stage === stage ? history : [...history, { stage, ts: existing?.ts ?? '' }],
            },
            ...list,
          ];
        }
        const funnel = { ...s.funnel };
        for (const k of Object.keys(funnel) as (keyof typeof funnel)[]) funnel[k] = 0;
        for (const x of list) if (funnel[x.stage] != null) funnel[x.stage]++;
        return { ...s, funnelList: list, funnel };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/** Відхилити вакансію (job_dismiss) — персистентне (stats.dismissedUrls,
 *  фідбек власника): раніше було лише сесійне ховання, вакансія поверталась
 *  після перезаходу. Оптимістичне оновлення — той самий патерн, що useJobStage. */
export function useJobDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { url: string; title: string }) => postEvent('job_dismiss', vars),
    onMutate: async ({ url }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => ({
        ...s,
        dismissedUrls: s.dismissedUrls.includes(url) ? s.dismissedUrls : [...s.dismissedUrls, url],
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/**
 * Архів збереженого сторінками по 50 (екран «Збережене»).
 *
 * useInfiniteQuery, а не ріст limit: сервер клампить limit до 50, тож старий
 * підхід («попроси 60») мовчки впирався в стелю на 51-му записі. Гортаємо
 * offset'ом; наступної сторінки немає, коли набрали total.
 *
 * ⚠️ Пагінація по offset + видалення = зсув: прибрали запис — і все за ним
 * зʼїхало на одиницю, тож наївний дозапис пропустив би сусіда. Тому видалення
 * інвалідує ['saved'] цілком (TanStack перетягує ВСІ набрані сторінки).
 */
export function useSavedArchive() {
  return useInfiniteQuery({
    queryKey: ['saved'],
    queryFn: ({ pageParam }) => fetchSaved(pageParam, SAVED_PAGE),
    initialPageParam: 0,
    // Правило гортання — чиста nextSavedOffset (тести: tests/saved-paging.test.ts).
    getNextPageParam: (_last, all) => nextSavedOffset(all),
  });
}

// ── F2: Налаштування ──

/** Налаштування власника + статус конекторів (третя незалежна черга). */
export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
}

const SETTINGS_SAVE_KEY = ['settings-save'];

/**
 * Зберегти налаштування. Екран шле ПАТЧ (один тумблер), а на сервер іде ПОВНИЙ
 * блоб — бо KV без CAS, і серверний read-modify-write губив би тумблери.
 *
 * Три речі тримають це вкупі, кожна закриває свою гонку:
 *
 * 1. scope — серіалізує запити. Без нього два швидкі тапи летять паралельно й
 *    останній PUT затирає попередній.
 * 2. mutationFn бере блоб із КЕШУ, а не з аргументів. onMutate завжди виконується
 *    ДО mutationFn, тож кеш уже містить і цей патч, і всі попередні. Якби payload
 *    збирався в компоненті з `settings` рендера, два тапи в одному тіку прочитали
 *    б той самий (ще не оновлений) стан — і другий загубив би перший. Це
 *    дзеркальне до пастки useVote: там читання кешу в mutationFn було багом, бо
 *    оптимістику треба було рахувати ДО патчу; тут навпаки — треба ПІСЛЯ.
 * 3. onSettled інвалідує лише коли черга спорожніла: інакше відповідь першої
 *    мутації перемалювала б тумблер, який друга щойно змінила.
 */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SETTINGS_SAVE_KEY,
    scope: { id: 'settings' },
    mutationFn: () => {
      const cur = qc.getQueryData<SettingsResponse>(['settings']);
      return cur ? postSettings(cur.settings) : Promise.resolve(null);
    },
    onMutate: async (patch: SettingsPatch) => {
      await qc.cancelQueries({ queryKey: ['settings'] });
      const prev = qc.getQueryData<SettingsResponse>(['settings']);
      qc.setQueryData<SettingsResponse>(['settings'], (old) =>
        old
          ? {
              ...old,
              settings: {
                quiet: { ...old.settings.quiet, ...(patch.quiet ?? {}) },
                modules: { ...old.settings.modules, ...(patch.modules ?? {}) },
                // mutedTopics — ПОВНА заміна, не мердж: патч несе весь новий
                // список, інакше зняти приглушення було б неможливо.
                mutedTopics: patch.mutedTopics ?? old.settings.mutedTopics,
              },
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['settings'], ctx.prev);
    },
    onSettled: () => {
      // === 1: поточна мутація ще рахується. Більше -> позаду черга, і рефетч
      // зараз показав би проміжний стан сервера замість останнього тапу.
      if (inTelegram() && qc.isMutating({ mutationKey: SETTINGS_SAVE_KEY }) === 1) {
        qc.invalidateQueries({ queryKey: ['settings'] });
      }
    },
  });
}

/**
 * Тижнева ціль подач (слайдер). Свідомо НЕ через /api/settings: ціль живе в
 * блобі `stats` поруч із weeklyApplied, тож це подія set_goal, як і решта
 * мутацій дашборда.
 */
const CHECKIN_SCOPE = { id: 'checkin-write' };

/**
 * Зберегти блок чек-іну (п.7).
 *
 * Шлемо ВЕСЬ блок одним запитом, а не по відповіді на питання: KV має ліміт
 * 1 запис/сек на ключ і не має CAS, тож чотири окремі події по ключу `stats`
 * — рівно та гонка, заради якої налаштування переробляли на повний PUT.
 * Дебаунс живе в екрані; scope серіалізує те, що все-таки полетіло підряд.
 *
 * `slot` тут — лише підказка: сервер визначає блок сам за київською годиною
 * (клієнтському годиннику не віримо) і може відповідь ЗІГНОРУВАТИ, якщо час
 * блоку вже минув. Тому onSettled перепитує ['stats'] — авторитет там.
 */
export function useSaveCheckin() {
  const qc = useQueryClient();
  return useMutation({
    scope: CHECKIN_SCOPE,
    mutationFn: (vars: { slot: CheckinSlot; answers: Record<string, unknown> }) =>
      postEvent('checkin', { slot: vars.slot, ...vars.answers }),
    onMutate: async ({ slot, answers }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => ({
        ...s,
        checkinToday: { ...s.checkinToday, [slot]: { ...s.checkinToday?.[slot], ...answers } },
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useSetGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { value: number }) => postEvent('set_goal', vars),
    onMutate: async ({ value }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => ({ ...s, goal: { ...s.goal, weeklyTarget: value } }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
