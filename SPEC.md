# Svitanok — персональний ранковий брифінг-бот (специфікація)

Документ-бриф для повного перепису проєкту в Claude Code. Описує архітектуру,
обмеження, контракти, **робочий процес розробки (git-flow + покрокові коміти)**
і фази. Реалізацію виконує Claude Code за цим документом.

> **Ревізія 5.** Повний перепис: **новий репо, нова папка, той самий бот** (§3).
> Модель розробки — **Opus** (`claude-opus-4-8`). Додано §17 (робочий процес:
> git-flow з гілками `main`/`develop`/`test`/`feature/*`, **покрокові коміти
> через `commit-commands`, push у кінці**), §18 (тулінг і налаштування репо).
> Внесено правки за підсумками Рев.4-імплементації — див. §19 (граблі, яких
> більше не повторюємо): уніфікований guard (єдине джерело істини),
> `workflow_dispatch` завжди форсує відправку, Telegram-діагностика і пошук
> `chat_id`, ліміти zod під тестовий період, зрізання API-ключа з URL,
> крос-платформні нюанси (Windows).
>
> **CLAUDE.md у папці проєкту НЕ створюємо** — конвенції живуть тут (§11, §17).
>
> На старті розробки тестовий період **01:00–23:00** (`sendHour: 1`,
> `sendWindowHours: 22`); наприкінці розробки окремим комітом/PR змінюється на
> бойові **08:00–12:00** (`sendHour: 8`, `sendWindowHours: 4`).
> Локації погоди: **дві**. Перша — геопозиція власника з KV (`ownerGeoManual` /
> `ownerGeo`, пише Mini App), друга — `OWNER_LOCATIONS[0]`. Немає геопозиції —
> обидві з `OWNER_LOCATIONS`; немає й її — публічний фолбек (Львів і Рівне).
>
> **Ревізія 5.1.** Знято внутрішні суперечності й латентні баги за підсумком
> адверсарного рев'ю: push — у кінці **кожного зрізу** (не всієї розробки, §17.2);
> продакшн-джоба й коміт стану — на гілці `state` без захисту, `main` лишається
> захищеним (§4.3); §0 під сценарій «новий репо» (створення, не звірка);
> guard — справжнє єдине джерело (standalone node-скрипт на системному node,
> §19.1); календарний DST (§19.11); entity-safe обрізання 4096 (§9);
> рання валідація критичних секретів (§4.1); уточнено quiet-day, RunBus-перелік
> локацій, межі тестового вікна, канонізацію URL з обох боків.

---

## 0. Передумова: перевірка готовності (Claude Code виконує ПЕРШИМ, до коду)

Перед будь-яким написанням коду Claude Code звіряє підготовчі кроки §12. Якщо
щось не зроблено — **НЕ починати збірку**, а провести власника по відповідному
пункту §12, перевірити результат, і лише тоді продовжити.

**Сценарій — НОВИЙ репо/папка (§3, §14):** проєкт створюється з нуля, тож репо
ще НЕ існує. Claude Code сам створює чисту директорію та `git init` (default-гілка
`main`), а не «звіряє наявність».

**Автоматична перевірка (Claude Code може сам):**

- цільова папка чиста/створюється; після `git init` default-гілка — `main`;
- `typescript` і `typescript-language-server` на PATH (`which typescript-language-server`);
- claude CLI встановлений, запінений, неінтерактивність (§2.1) налаштована;
- **`llm.model` реально доступна на Pro через `claude -p`** — найкрихкіша
  передумова всієї курації; звірити дрібним пробним викликом до збірки news;
- Node ≥ 20 (LTS); пін версії у `.nvmrc`;
- очікувані env-змінні описані в `.env.example`; у локальному `--dry-run`
  відсутня env-змінна дає **явну** помилку, не тиху.

**Підтвердження від власника (секрети Claude Code не бачить, тому питає):**

- `TELEGRAM_BOT_TOKEN` і `chat_id` отримані (для `chat_id` — див. §6 діагностика);
- `CLAUDE_CODE_OAUTH_TOKEN` згенерований (`claude setup-token`);
- `WEATHER_API_KEY` є;
- Google (опційно для календаря): OAuth client створений, **опублікований у
  Production**, `GOOGLE_REFRESH_TOKEN` + client id/secret згенеровані;
- усі значення в GitHub Secrets (не у файлах).

**Мінімум для вертикального зрізу (weather):** репо, TS-бінарники, claude OAuth,
`WEATHER_API_KEY`, `TELEGRAM_BOT_TOKEN` + `chat_id`. Google і новини — пізніше.

---

## 1. Мета

Щоранку о 08:00 (Київ) надсилати в Telegram один структурований брифінг:
спокійний рядок зверху, синтез «на сьогодні» (погода по двох локаціях +
календар), розумні новини, дієва картка «крок до офера». Тихий день — короткий
брифінг. Неділя — багатший weekly review.

Користувач один (власник). Запуск у хмарі (GitHub Actions), без увімкненого
ноута. Курація — на Pro-підписці через Claude Code (`claude -p`), не через
платний API.

---

## 2. Архітектурні обмеження (must follow)

- Мова/рантайм: **Node.js + TypeScript** (ESM, `strict`).
- Планувальник: **GitHub Actions cron**. Cron у UTC; 08:00 Київ = 05:00 (літо,
  EEST=UTC+3) / 06:00 (зима, EET=UTC+2). Запускати о 05:00 і 06:00 UTC.
- **Guard на відправку — ідемпотентний, з вікном, ЄДИНЕ ДЖЕРЕЛО ІСТИНИ** (§4.1,
  §19.1). Умова: `sendHour <= kyivHour < sendHour + sendWindowHours` **І**
  сьогодні ще не слали. Нижня межа ловить спізнення cron; **верхня межа
  обовʼязкова** — без неї спізніла джоба надішле «ранковий» брифінг опівночі.
- **Guard виконується рано** (після дешевого checkout, до `npm ci` й claude CLI),
  щоб скіпнута джоба не палила хвилини. **Єдине джерело істини** — окремий
  крихітний node-скрипт `scripts/guard.mjs`, що запускається на **системному
  node** runner-а (передвстановлений на `ubuntu-latest`, `npm ci` не потрібен),
  читає `config.yml` і друкує рішення. Жодного дублювання логіки порівняння в
  bash (§19.1).
- **Ручний `workflow_dispatch` завжди форсує відправку** (`--force`), обходячи
  вікно та ідемпотентність: натиснув кнопку — хочеш зараз (§19.2).
- **`concurrency` group** на workflow: `{ group: svitanok-brief,
cancel-in-progress: false }` — щоб ручний запуск під час scheduled не дав гонку.
- Аутентифікація Claude: **CLAUDE_CODE_OAUTH_TOKEN** (`claude setup-token`).
  Messages API НЕ використовуємо. **Неінтерактивність обовʼязкова** (§2.1).
- Оркестратор тонкий і детермінований. Детерміновані модулі — звичайний код,
  нуль квоти. Через Claude — тільки модулі з реальною курацією (новини).
- Стан і конфіг — у тому ж **приватному** репо. **Стан комітиться у незахищену
  гілку `state`, НЕ в `main`** (§4.3) — щоб branch protection `main` не валив
  щоденний коміт бота.
- Принципи: SOLID, DI через `ctx`, абстракції замість конкретики.
- Telegram: parse mode **HTML**, expandable-цитати, фіксований порядок секцій,
  **обробка ліміту 4096** (§9).

### 2.1 Неінтерактивність claude -p

У CI перший виклик у новій директорії може спитати «trust this folder?» або
смикнути onboarding — у неінтерактивному середовищі це висне до таймауту, і
брифінг тихо не приходить. Перед першим викликом пресідити `~/.claude.json` з
`hasCompletedOnboarding: true` (+ обхід trust-промпта), або відповідний прапор
поточної версії CLI. Запінити версію CLI; перевірити поведінку при реалізації.

---

## 3. Структура репо (норми)

```
svitanok/
  .github/
    workflows/
      brief.yml            # cron + dispatch, concurrency, guard-gate, build, run
      ci.yml               # PR-гейт: typecheck + lint + test (+ security-review)
    pull_request_template.md
  src/
    orchestrator.ts        # load -> guard -> producers -> consumers -> render -> send -> commit
    core/
      types.ts
      registry.ts          # реєстр модулів: список producers/consumers + їх порядок
      config.ts            # завантаження + zod-валідація
      state.ts             # StateStore (довговічний стан) + prune
      bus.ts               # RunBus (transient, in-memory)
      clock.ts             # київський час, DST
      guard.ts             # ЄДИНИЙ sendGuard (вікно + ідемпотентність)
      llm.ts               # LLMClient (claude -p, пін моделі, timeout)
      fetcher.ts           # SourceFetcher (allowlist, timeout, retry/backoff)
      url.ts               # канонізація URL + зрізання ключів
      telegram.ts          # Notifier (HTML-escape, чанкінг 4096, fail-notify)
      render.ts            # Block[] -> повідомлення (розбиття за лімітом)
      logger.ts
    modules/
      _template.ts
      stoic.ts
      weather.ts           # producer: кілька локацій
      calendar.ts          # producer
      today.ts             # consumer: синтез weather+calendar
      news.ts              # consumer (LLM)
      next-step.ts         # consumer
      weekly-review.ts     # consumer (нд)
    data/
      stoic.json           # public-domain цитати за датою MM-DD (366), УКРАЇНСЬКОЮ
  scripts/
    check-telegram.mjs     # діагностика бота / пошук chat_id (§6)
    guard.mjs              # standalone guard на системному node для CI (§2, §19.1)
  tests/                   # дзеркалить src/ (clock, guard, url, telegram, render, stoic,
                           # weather-multi, calendar-tz, flow). Каталог `tests/`, не `test/`,
                           # щоб не плутати з гілкою `test` (§17.1).
  config.yml
  state.json
  .env.example
  .gitignore
  .gitattributes           # * text=auto eol=lf — стабільні діфи між OS
  .editorconfig
  .nvmrc
  eslint.config.js
  .prettierrc
  package.json
  package-lock.json
  tsconfig.json
  README.md
  SPEC.md                  # цей файл (конвенції — тут, §11/§17; окремого CLAUDE.md НЕ створювати)
```

> **Новий репо, нова папка, той самий бот.** Проєкт створюється з нуля в чистій
> директорії та новому приватному репо; логіка/поведінка бота — та сама.
> **CLAUDE.md у папці проєкту НЕ створюємо** — усі конвенції живуть у цьому SPEC.md.

> «Тихий день — логіка оркестратора», тож окремого файлу `quiet-day.ts` немає —
> поведінка живе в `orchestrator.ts` (§6).

---

## 4. Контракт модуля (ядро розширюваності)

```ts
// core/types.ts
export interface Button {
  label: string;
  action: string;
}

export interface Block {
  id: string;
  title: string;
  icon?: string;
  summary: string; // показується завжди
  detail?: string; // ховається в expandable
  buttons?: Button[];
  priority: number; // порядок ВІДОБРАЖЕННЯ (менше = вище)
  // Поля `fresh` немає. Єдиний сигнал «нічого свіжого» — run() повертає null.
}

export interface StateStore {
  // довговічний стан МІЖ запусками
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  flush(): Promise<void>;
  prune(): void;
}

export interface RunBus {
  // transient producer->consumer У МЕЖАХ запуску
  get<T>(key: string): T | undefined; // in-memory, НЕ персиститься, НЕ комітиться
  set<T>(key: string, value: T): void;
}

export interface LLMClient {
  complete(prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

export interface SourceFetcher {
  fetch(url: string): Promise<string>; // тільки allowlist; таймаут; ретрай з бекофом
}

export interface Clock {
  now(): Date; // київський час
  kyivHour(): number;
  todayKey(): string; // "YYYY-MM-DD" київський
  isSunday(): boolean;
}

export interface Ctx<TConfig = unknown> {
  clock: Clock;
  config: TConfig;
  state: StateStore;
  bus: RunBus;
  llm: LLMClient;
  fetcher: SourceFetcher;
  log: Logger;
}

export type ModuleKind = 'producer' | 'consumer';

export interface Module<TConfig = unknown> {
  id: string;
  kind: ModuleKind;
  enabled(config: TConfig): boolean;
  run(ctx: Ctx<TConfig>): Promise<Block | null>;
  handleCallback?(action: string, ctx: Ctx<TConfig>): Promise<void>; // фаза B
}
```

> Модулям передається **повний типізований конфіг** (`Ctx.config`), кожен модуль
> описує свій зріз (напр. `{ modules: { weather: {...} }, locations: [...] }`).
> Це усуває клас помилок «модуль не бачить поле верхнього рівня» (§19.5).

### 4.1 Порядок виконання оркестратора (двофазний)

`today` синтезує погоду + календар → **залежить** від їхніх виходів. Канал
передачі — **RunBus**, не StateStore.

0. **Рання валідація критичних секретів:** перед усім перевірити наявність
   `TELEGRAM_BOT_TOKEN` і `TELEGRAM_CHAT_ID`. Якщо їх немає — fail-notify теж не
   спрацює, тож збій буде **тихим** (§19.12). Тому: логувати гучно + (за змоги)
   завершитись ненульовим кодом, щоб GitHub Actions позначив ран як failed
   (видимий сигнал замість тиші).
1. **Guard (рано):** логіка `core/guard.ts` (та сама, що в `scripts/guard.mjs`,
   §19.1) рахує `shouldSend` із `config` і `lastSentDate`. `--dry-run` → завжди
   рахує й друкує, не шле. `--force` → обходить вікно та ідемпотентність, шле.
   Інакше — за вікном.
2. **Фаза 1 (producers):** weather (всі локації), calendar. `Promise.allSettled`.
   Кожен пише нормалізовані дані в `bus` і повертає Block.
3. **Фаза 2 (consumers):** today, news, next-step, stoic (нд: weekly-review).
   Теж `allSettled`.
4. Зібрати ненульові Block, відсортувати за `priority`.
5. Quiet-day (§6): немає свіжих новин І немає подій → короткий брифінг.
   **Неділя має пріоритет:** якщо неділя — weekly-review показується завжди
   (навіть у тихий день); quiet-day лише скорочує решту блоків.
6. Render → send → **`state.set("lastSentDate")` → commit у гілку `state`**
   (§4.2, §4.3) → `prune` → `flush`.

Один впалий модуль не валить брифінг. Якщо падає оркестратор/auth/CLI —
top-level catch (§8) шле власнику мінімальне попередження напряму через bot
token. Тиша — або свідомий «тихий день», або явний фейл, ніколи неоднозначна.

### 4.2 Семантика доставки: at-least-once (свідомо)

Порядок: **send → set lastSentDate → commit**. Якщо `send` пройшов, а `commit`
впав — наступний ран повторить. Це свідомий **at-least-once**: рідкісний дубль
прийнятніший за німий пропуск. Дубль логувати гучно. Не переставляти на
commit-before-send.

### 4.3 Куди комітиться стан (узгодження з захистом `main`)

`main` захищений (§17.1: прямий пуш заборонений, лише через PR). Але продакшн-бот
**щодня пушить `state.json`** напряму — це несумісно із захистом `main`. Рішення:

- **Стан живе в окремій незахищеній гілці `state`.** `brief.yml` працює з неї:
  `checkout` гілки `state`, оновлює `state.json`, `commit` + `push origin state`.
  `config.yml` і код береться з `main` (або `state` ребейзиться на `main`).
- На `state` НЕ діє branch protection, тож щоденний коміт бота проходить без PR.
- Перед push — `git pull --rebase origin state` (race ручного dispatch, §11).
- Бот має власну git-identity (`GIT_AUTHOR_*`/`GIT_COMMITTER_*`, §18).

> Альтернатива (якщо не хочеш окремої гілки): зняти protection із `main` і
> покладатись на `concurrency` + `[skip ci]`. Гілка `state` — чистіше: `main`
> лишається захищеним і лінійним, шум коміту стану ізольований.

---

## 5. Модулі MVP

| id            | kind           | опис                                                                |
| ------------- | -------------- | ------------------------------------------------------------------- |
| stoic         | consumer       | public-domain цитата за датою (MM-DD), **українською**              |
| weather       | producer       | погода по **кількох локаціях** (з `OWNER_LOCATIONS`); пише в RunBus |
| calendar      | producer       | події Google Calendar на сьогодні; пише в RunBus                    |
| today         | consumer       | синтез weather+calendar одним рядком                                |
| news          | consumer (LLM) | топ 2-3 на категорію, дедуп, адаптивний фільтр ❤️                   |
| next-step     | consumer       | «крок до офера», ротація                                            |
| weekly-review | consumer (нд)  | багатший брифінг по неділях                                         |

Порядок ВІДОБРАЖЕННЯ (priority): stoic → today → calendar → weather → news →
next-step. Weekly-review замінює набір у неділю.

> **kind** керує порядком ВИКОНАННЯ (producer перші); **priority** — порядком
> ВІДОБРАЖЕННЯ. Дві різні осі.

---

## 6. Деталі ключових модулів

### weather (producer, кілька локацій)

Конфіг містить **список** локацій (публічний фолбек; справжні — в `OWNER_LOCATIONS`). Модуль фетчить кожну,
пише в RunBus `weather.today.<slug>` `{ tempC, condition, willRain, willBeCold,
... }` і повертає **один** Block, що показує обидві локації рядками з дією
(«бери парасольку»), не голі градуси. Один впалий фетч локації не валить інші
(деградує до доступних). API-ключ у URL — **ніколи в лог/стан** (§8, §19.4).

- **Пороги дії (явні, не на розсуд):** `willBeCold = tempC < 10`;
  `willRain` — за кодом погоди провайдера (rain/drizzle/thunderstorm/snow).
  Винести пороги в константи модуля.
- **`slug` локації** — детермінований (напр. транслітерація `name` або індекс),
  щоб `today` міг відтворити ключі. RunBus не має перелічення ключів, тому
  **`today` бере перелік локацій з `config.locations` і будує ті самі `slug`**
  (§6 today), а не «сканує» bus.

### calendar (producer, Google Calendar)

Події на сьогодні через OAuth refresh token (`calendar.readonly`).

> ⚠️ Refresh token протухає за 7 днів, якщо OAuth-застосунок у статусі
> «Testing». Дія: опублікувати у **Production**. Фолбек: ловити 401/invalid_grant,
> повертати `null` (не валити брифінг), логувати явну причину.
>
> ⚠️ **DST у межах дня (§19.11):** `timeMin`/`timeMax` НЕ хардкодити `+03:00` —
> узимку Київ `+02:00`, інакше події дня зсунуться/обріжуться. Будувати межі
> через коректну TZ `Europe/Kyiv` (напр. `Intl`/`Temporal` або обчислений
> поточний офсет), а не фіксований рядок офсету.

### stoic (consumer)

- **Цитати українською**, тільки з public-domain джерел АБО власний переклад з
  public-domain оригіналу (Марк Аврелій, Сенека, Епіктет). **Копірайт стосується
  й перекладу** — сучасні україномовні переклади можуть бути під охороною.
  Атрибуції звіряти з джерелом, не вигадувати.
- Ключ — рядок `MM-DD` (не day-of-year). Кейс `02-29` у невисокосний рік →
  детермінований фолбек (`02-28`).
- Старт — кілька десятків записів-заглушок (помічених), повні 366 — окремою
  фазою/PR (§10).

### today (consumer)

Бере перелік локацій з `config.locations`, будує ті самі `slug` і читає
`weather.today.<slug>` для кожної (RunBus не перелічує ключі — §6 weather);
плюс `calendar.today`. Якщо продюсер упав — синтезує з наявного або повертає
`null`. Сам нічого не фетчить. Рядок «на сьогодні» згортає обидві локації
людяно (напр. «Львів +12°, друга локація +9° ☔»), без дублювання з блоком weather (§9).

### news (consumer, LLM)

1. Allowlist RSS/API на категорію в config.yml.
2. Fetch → **канонізація URL** (`core/url.ts`: нижній регістр схеми/хоста,
   зрізати `utm_*`/трекінг, зрізати **ключі** `apikey/api_key/appid/token/...`,
   прибрати трейлінг-слеш) → дедуп проти `state.shownNews` (вікно `dedupDays`).
3. Один `llm.complete` (пін моделі, timeout) на всі категорії; врахувати
   `state.preferenceWeights`. Строгий JSON `{ items:[{title,url,category,why}] }`.
4. **zod-валідація + перевірка існування URL** — відкинути item, чий `url` не
   входить у множину фактично зафетчених. **Порівнювати канонізовані форми з
   обох боків** (і фетчені URL, і URL від LLM проганяти через `core/url.ts`),
   інакше валідні лінки хибно відкидатимуться (захист від галюцинацій).
5. **Зберігати ПУБЛІЧНИЙ URL без ключа** — ні в `shownNews`, ні в лог, ні в
   повідомлення (§19.4).
6. Записати показані публічні URL у `state.shownNews` з датою.
7. Кнопки `Більше: <категорія>`; `why` — в expandable. ❤️ (фаза B) → §6.1.

#### 6.1 preferenceWeights

Вага на категорію в `[0.5, 2.0]`, старт `1.0`. ❤️: `+0.15` (max 2.0); повторний
тап знімає лайк і відкочує рівно застосовану дельту. Decay раз на тиждень:
`w += (1.0 - w) * 0.1`. Вага множить важливість, не занулює.

**Легасі-дизлайки.** До ❤️ існував і 👎 (`-0.15`, min 0.5). Створити новий
дизлайк уже НЕ можна (`POST /api/vote` віддає 400 на будь-що, крім `dir:'up'`),
але прочитати збережений — обовʼязково: `applyUrlVote` і `recordEvent('vote')`
далі розуміють `dir:'down'`, бо саме його треба відкотити, коли власник лайкне
раніше дизлайкнуту новину. `stats.votes` фільтрує їх із READ (кнопки 👎 немає —
підсвічувати нічим). Ваги, просаджені старими дизлайками, самі повзуть до `1.0`
щотижневим decay; окремої міграції немає свідомо.

### next-step (consumer)

Ротація з config-списку; індекс у state, при правці списку валідувати межі
(`index % steps.length`).

### quiet-day (логіка оркестратора)

Тихий день = жодне з джерел у `quietDay.triggerOn` не дало контенту. Семантика
списку — **AND по перелічених**: тихий день, лише якщо ВСІ вказані порожні
(дефолт `["news","calendar"]` → немає свіжих новин **І** немає подій). Стоїк/
next-step тоді скорочено (тільки summary). **Неділя — виняток:** weekly-review
показується завжди, quiet-day лише скорочує решту (§4.1 п.5).

### weekly-review (consumer, неділя)

Ревʼю тижня: показані новини по категоріях, виконані next-step. Retention 7 днів
у state. Prune: `shownNews` за `max(dedupDays, retentionDays)`, історія next-step
за 7 днів.

### 🔧 Telegram-діагностика і пошук chat_id (`scripts/check-telegram.mjs`)

Окремий скрипт (без залежностей, читає `.env`): `getMe` (валідність токена) →
`getUpdates` (показати `chat_id`, що писали боту) → `sendMessage` (тест на
`TELEGRAM_CHAT_ID`). Токен у виводі маскований. Це **обовʼязковий артефакт** —
рятує від класу «бот мовчить, бо chat_id не той / не натиснув Start» (§19.3).
Часті причини: 400 (невірний chat_id або не починав чат), 403 (заблокував /
не натиснув Start).

---

## 7. Конфіг (config.yml)

```yaml
timezone: Europe/Kyiv

# ТЕСТОВИЙ ПЕРІОД на час розробки: вікно [1, 23) = 01:00–22:59 Київ
# (верхня межа невключна: kyivHour < sendHour+sendWindowHours).
# Наприкінці розробки окремим комітом/PR -> sendHour: 8, sendWindowHours: 4.
sendHour: 1
sendWindowHours: 22

locations:
  - { lat: 49.8397, lon: 24.0297, name: 'Львів' }
  - { lat: 50.6199, lon: 26.2516, name: 'Рівне' } # публічний фолбек; справжні — в OWNER_LOCATIONS

quietDay:
  triggerOn: ['news', 'calendar']

modules:
  stoic: { enabled: true }
  weather: { enabled: true }
  calendar: { enabled: false } # увімкнути після Google OAuth
  news:
    enabled: false # увімкнути після джерел
    categories: ['Україна та світ', 'Технології / IT', 'Спорт', 'Наука / економіка']
    perCategory: 2
    dedupDays: 3
    retentionDays: 7
    sources: {}
  nextStep:
    enabled: true
    steps: ['Пофіксити OG-теги', 'Mock-питання з KB', '...']
  weeklyReview: { enabled: true, day: 'sunday' }

llm:
  model: 'claude-...' # пін моделі, ДОСТУПНОЇ на Pro через claude -p; звірити при сетапі (§0)
  maxCallsPerRun: 2 # стеля викликів за ран (news = 1; запас на ретрай/майбутній модуль)
  timeoutMs: 90000

fetch:
  timeoutMs: 30000
  retries: 2

telegram:
  maxMessageChars: 3900 # запас під ліміт 4096
```

**zod-валідація:**

- `sendHour`: 0–23; `sendWindowHours`: **1–23** (щоб тестовий період проходив —
  §19.6); інваріант `sendHour + sendWindowHours <= 24` (без wraparound через
  північ). Вікно — `[sendHour, sendHour+sendWindowHours)`, верх **невключний**.
- `locations`: непорожній масив; кожна — `{ lat, lon, name }`.
- Невалідний конфіг падає **гучно** на старті (на відміну від рантайм-помилок
  модулів, що деградують тихо).

---

## 8. Вимоги безпеки (реалізувати явно)

- Секрети тільки з env/GitHub Secrets, ніколи у файлах, логах, комітах.
- **`state.json` і логи не містять URL з ключами** (§6 news п.5, §19.4).
- Workflow: **top-level `permissions: {}`**, точково `contents: write` у джобі.
- **Сторонні Actions пінити по commit SHA**, не по `@v4`. Пін версії claude CLI.
- SourceFetcher — тільки allowlist; лінки з контенту server-side не відкриваємо (SSRF).
- **HTML-escape на ВСІ динамічні поля** (title/why від LLM, назви подій, погода).
- Уся відповідь LLM — zod + перевірка існування URL; вивід не керує shell/eval.
- Фетчений контент у промпті відмежований як дані (prompt injection ігнорується).
- **Таймаути на кожну зовнішню операцію** (`claude -p`, fetch).
- **Guard `maxCallsPerRun`** на LLM-виклики.
- **Жодного `child_process.exec` зі склейкою рядків — тільки `execFile`/`spawn`
  з масивом аргументів** (§19.7). Git-операції коміту стану — через `execFile`.
- `npm ci` з лок-файлом; Dependabot; мінімум залежностей.
- `state.json` парситься захищено; биття → фолбек на порожній стан (втрата
  `lastSentDate` → можливий дубль, прийнятно за at-least-once; втрата
  `shownNews` → тимчасовий повтор новин — прийнятно).
- **Рання валідація критичних секретів** (`TELEGRAM_BOT_TOKEN`/`CHAT_ID`) до
  будь-якої роботи: без них fail-notify теж німий, тож завершуватись видимим
  failed-раном, не тихо (§4.1 п.0, §19.12).
- `js-yaml` — безпечний `load` (без кастомних конструкторів).
- Фаза B (webhook): перевірка `X-Telegram-Bot-Api-Secret-Token` + allowlist по `chat_id`.

---

## 9. Презентація (ліміт 4096)

- HTML; escape всіх динамічних полів. Фіксований порядок, тонкі роздільники,
  один іконковий якір на блок. `summary` завжди; `detail` — `<blockquote
expandable>`.
- Зверху: дата, день тижня (локаль **uk-UA**) + рядок стоїка. Далі синтез
  «на сьогодні». Внизу: інлайн-кнопки (активні у фазі B).
- **Today і weather не впритул** — щоб не дублювати число (тонкий роздільник).
- Тихий день: тільки summary.
- **Ліміт 4096:** render рахує довжину; понад `telegram.maxMessageChars` —
  спершу скоротити `detail` найдовших блоків; далі — розбити на кілька
  повідомлень **на межі блоків** (не рвати блок). Telegram-sender чанкує.
  - **Обрізання — entity-safe:** не різати посеред HTML-сутності (`&amp;`) чи
    тега (`<blockquote>`). Обрізати по escaped-тексту так, щоб не лишити
    «обірваної» сутності/тега (escape ПІСЛЯ обрізання, або різати по безпечних
    межах + додавати `…`).
  - **Один блок сам > ліміту:** якщо навіть із порожнім `detail` блок
    перевищує `maxMessageChars` — обрізати вже `summary` (entity-safe) з `…`,
    блок усе одно йде окремим повідомленням. Брифінг не має падати на 400.
  - **Лічильник довжини** — у тих самих одиницях, що рахує Telegram (UTF-16
    code units; емодзі = сурогатна пара). `string.length` у JS підходить.

---

## 10. Фази

**Фаза A (MVP):** cron-пуш, `concurrency`, уніфікований guard з вікном (читає
config, dispatch форсує), усі модулі, `--dry-run`/`--force`, коміт стану
(at-least-once), top-level фейл-нотифай, неінтерактивний `claude -p`, обробка
4096, погода по двох локаціях, Telegram-діагностика, CI-гейт (typecheck+lint+
test, security-review). Кнопки малюються, оживуть у фазі B. Наприкінці — окремий
PR «бойовий час» (08:00–12:00) і наповнення `stoic.json` (366 укр. цитат).

**Фаза B (інтерактив):** Cloudflare Worker як webhook. Команди/кнопки, ❤️ (тоді 👍/👎).
Важкі запити Worker тригерить через `workflow_dispatch`. Миттєвий ack, контент
догруповує окремим повідомленням.

---

## 11. Стандарт комітів

**Conventional Commits**, дрібні й логічно-цілісні (§17). Стан:
`chore(state): brief 2026-06-26 [skip ci]` — у гілку **`state`** (§4.3). Фічеві:
`feat(weather): multi-location fetch`, `fix(guard): single-source send guard`.
**Push стану:** перед `git push origin state` — `git pull --rebase origin state`
(або ловити non-fast-forward і ретраїти).

---

## 12. Що має зробити власник (поза Claude Code)

1. Приватний репо `svitanok`, default-гілка `main`.
2. @BotFather → `TELEGRAM_BOT_TOKEN`; `chat_id` знайти через `scripts/check-telegram.mjs` (§6).
   Вільний текст у групі доходить до бота, лише якщо він **адмін групи** АБО якщо
   вимкнено приватність (**@BotFather → `/setprivacy` → Disable**). Інакше Telegram
   доставляє лише команди, згадки й відповіді на повідомлення бота — `/start`
   працює, а «знайди лист…» зникає без сліду.
   Окремо: вільний текст іде до асистента лише в темі `TOPIC_ASSISTANT` (або в чаті
   без тем) — секрет має бути заданий У ВОРКЕРІ, не лише в GitHub Actions.
   Перевірити обидва факти: `/whereami`.
3. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
4. Ключ погоди → `WEATHER_API_KEY`.
5. (Опц.) Google OAuth: client (Desktop), скоуп `calendar.readonly`,
   **опублікувати у Production**, refresh token → `GOOGLE_REFRESH_TOKEN`
   (+ id/secret).
6. Усе в GitHub Secrets (без лапок/пробілів на кінцях — часта причина 400/401).
7. Тулінг (§18): `typescript-language-server` на PATH; плагіни `typescript-lsp`
   і `security-guidance` на user scope.

---

## 13. Тести (мінімум для безнаглядної джоби)

Юніти: `clock` (DST літо/зима), `guard` (затримка в межах вікна шле; поза верхнім
вікном скіпає; друга джоба того ж дня скіпає; `--force` обходить; межа [1,23)
коректна — 23:00 скіпає), `telegram` (HTML-escape; чанкінг на межі блоків;
**entity-safe обрізання**; один блок > ліміту), `url` (канонізація + **зрізання
ключа, включно з `appid`**; **однакова канонізація обох боків** для news-дедупу),
`stoic` (MM-DD; 02-29 фолбек), `news` (відкидання неіснуючого URL), `render`
(розбиття), `weather` (**кілька локацій: одна впала — інші лишаються; slug
детермінований**), `calendar` (**межі дня в зимовій/літній TZ — без хардкоду
`+03:00`**).

Флоу оркестратора: усі модулі `null` → quiet-day (не порожнє); producer кинув
виняток → graceful degradation; гонка дубля заблокована guard; **неділя — weekly-
review навіть у тихий день**; **відсутній `TELEGRAM_BOT_TOKEN` → видимий
failed-ран, не тиша**. `--dry-run` — для ручної перевірки, не заміна юнітам.

---

## 14. Як передати в Claude Code

**Спершу §0.** Далі — НЕ все одразу, а за git-flow (§17) вертикальними зрізами.
**Новий репо, нова папка, той самий бот** (§3): почати з чистої директорії,
`git init`, default-гілка `main`. **CLAUDE.md у папці НЕ створювати.**

> «Працюй за SPEC.md, модель **Opus**. Спершу §0 (готовність). Створи новий
> репо/папку, `main` як default. Тоді за §17 заведи `develop` і `test`, і для
> кожного зрізу — окрему `feature/*` гілку. Коміти роби **покроково, по одному
> логічному кроку, через `commit-commands` (НЕ один великий коміт)**; коміти
> локальні, **push — у кінці КОЖНОГО ЗРІЗУ**, тоді PR у `develop`. Зріз 1:
> scaffold + tooling (§18) + `scripts/guard.mjs`. Зріз 2: core/clock + core/guard
> (єдиний guard, читає config, `--force`) + тести DST/вікна/[1,23). Зріз 3:
> решта core (+ рання валідація секретів, §4.1 п.0). Зріз 4: orchestrator
> (двофазний) + weather (дві локації з конфігу) end-to-end з `--dry-run`.
> Зріз 5: Telegram-діагностика. Далі модулі по одному, consumer-и після
> producer-ів (calendar — з коректною TZ, §19.11). Кожен зріз → PR у `develop`;
> інтеграційні/ручні прогони — на `test` (тестовий час). Стан комітиться в гілку
> `state` (§4.3). Наприкінці `develop → main` і PR `бойовий час` (08:00–12:00).
> Закладай ОДРАЗУ: top-level фейл-нотифай, неінтерактивний claude -p,
> concurrency, обробку 4096. CLAUDE.md не створюй.»

---

## 15. Промпт для адверсарного рев'ю (прогнати окремо)

Перед мерджем у `main` і періодично — окремою сесією, без правок без погодження:

```
Ти — адверсарний рецензент цього SPEC.md і коду. НЕ виправляй. Знайди проблеми,
згрупуй за severity (CRITICAL/HIGH/MEDIUM/LOW), для кожної — місце, наслідок,
пропозиція. Чекай мого рішення. Шість проходів:
1. БЕЗПЕКА (секрети в логах/URL; permissions; пін Actions по SHA; SSRF/allowlist;
   HTML-escape; prompt injection; валідація LLM і неіснуючих URL; webhook secret;
   таймаути; guard квоти; неінтерактивність; execFile vs exec).
2. ВНУТРІШНЯ УЗГОДЖЕНІСТЬ (єдиний guard як один скрипт vs дублювання в bash;
   push-по-зрізах vs git-flow/test-гілка; захист main vs коміт стану в `state`;
   producer/consumer vs паралель; quiet-day vs завжди-не-null і неділя;
   StateStore vs RunBus і перелік локацій; повний config у Ctx).
3. РЕЖИМИ ВІДМОВИ (таймаут/401/порожня відповідь/збій коміту → тихий день або
   явний фейл, ніколи неоднозначно; **відсутній bot-token → видимий failed,
   не тиша**; at-least-once коректний).
4. КРАЙОВІ ВИПАДКИ (DST cron + **календарний DST у межах дня**; спізнення cron;
   верхнє вікно і межа [1,23); інваріант sendHour+window<=24; 4096 +
   entity-safe обрізання + блок>ліміту; 02-29; гонки коміту в `state`; OAuth;
   dispatch race; одна локація погоди впала).
5. КОПІРАЙТ (stoic: PD-джерело, реальні атрибуції, переклад без чинної охорони).
6. ЧОГО СПЕКА НЕ ПОКРИВАЄ.
Наприкінці — вердикт build-ready чи ні + топ-3 блокери.
```

---

## 16. Тулінг розробки (плагіни)

На **user scope**: `typescript-lsp` (потребує `typescript-language-server` на
PATH; пост-едит діагностика тримає код type-clean), `security-guidance`
(інлайн-перевірка, працює В ПАРІ з §8 — §8 джерело істини). `security-review`
(GitHub Action) — CI-гейт (§10). Максимум 2-3 активні плагіни; тільки офіційні.

---

## 17. Робочий процес розробки — git-flow + покрокові коміти (ОБОВ'ЯЗКОВО)

> Це головна зміна Рев.5: **не «написав усе → один великий пуш», а
> структурована історія**. Причина — §19: великі змішані коміти ховають баги й
> ускладнюють відкат.

### 17.1 Гілки (git-flow)

- **`main`** — лише бойове, лише через PR. Прямий пуш заборонений.
- **`develop`** — інтеграційна гілка; сюди мерджаться `feature/*`.
- **`test`** — окрема гілка для перевірки воркфлоу в CI перед промоутом у `main`:
  тут живе тестова конфігурація (тестовий час, вікно [1,23)), сюди робимо
  ручні `workflow_dispatch`-прогони й перевіряємо живу доставку в Telegram.
  Бойові правки в `test` не комітимо — лише тестові; у `main` іде вже
  перевірений `develop` з бойовим часом.
- **`state`** — службова **незахищена** гілка лише для `state.json`: сюди
  продакшн-бот щодня комітить стан, оминаючи захист `main` (§4.3, §19.13).
  Не для коду — лише машинні коміти стану.
- **`feature/<scope>`** — одна гілка на логічний зріз/етап. Приклади:
  `feature/scaffold`, `feature/core-clock-guard`, `feature/core-infra`,
  `feature/orchestrator-weather`, `feature/telegram-diagnostic`,
  `feature/module-stoic`, `feature/module-calendar`, `feature/module-today`,
  `feature/module-news`, `feature/module-next-step`,
  `feature/module-weekly-review`, `feature/production-time`,
  `feature/stoic-data-366`.
- (Опц.) `fix/<scope>`, `chore/<scope>` за тим самим принципом.

Потік: `feature/*` → PR у `develop` → (CI зелений) merge → … → інтеграційну
перевірку ганяємо на `test` (тестовий час, ручні прогони) → наприкінці зрізу
`develop` → PR у `main`.

### 17.2 Покрокові коміти — ОБОВ'ЯЗКОВО, А НЕ ВСЕ ОДРАЗУ

> 🔴 **Найважливіше правило процесу.** Коміти робляться **покроково, по ходу
> розробки** — кожен логічний крок окремим комітом. **Категорично заборонено**
> писати весь модуль/проєкт і робити один великий коміт «все одразу». Історія
> має читатись як послідовність дрібних зрозумілих кроків.

- **Один логічно-цілісний крок = один коміт.** Не змішувати непов'язані зміни.
  Приклад послідовності в `feature/core-clock-guard`:
  1. `feat(clock): add Kyiv time + DST helpers`
  2. `test(clock): DST summer/winter`
  3. `feat(guard): unified send guard reading config`
  4. `test(guard): window, idempotency, force, 01-23 test period`
- **Комітити лише коли крок проходить** typecheck + відповідні тести (локальний
  pre-commit гейт — §18). «Зелений» проміжний стан у кожному коміті.
- **Коміти — розумні й структуровані. Створювати їх через `commit-commands`**
  (skill `commit-commands:commit`; для фінального push+PR — `commit-push-pr`).
  Якщо скіл недоступний у сесії — **фолбек:** звичайний `git commit` з тим самим
  Conventional-стандартом (не блокувати розробку). Кожен коміт логічно
  згрупований, тіло пояснює _чому_, не лише _що_.
- **Пуш — у кінці КОЖНОГО ЗРІЗУ, не всієї розробки.** Під час зрізу коміти
  **локальні** (не пушити після кожного кроку). Коли зріз готовий (усі його
  коміти зелені) — `push` гілки `feature/*` і відкриваємо PR у `develop`.
  Так зберігається і покрокова локальна історія, і git-flow/CI/`test`-перевірка
  по зрізах (інакше без push неможливо ні PR, ні `workflow_dispatch` на `test`).
- НЕ amend-ити вже запушені коміти; новий коміт замість переписування історії.

### 17.3 PR-дисципліна

- Кожен PR малий, з описом (шаблон `pull_request_template.md`): що, навіщо, як
  перевірено. CI (typecheck+lint+test) має бути зелений до merge.
- Squash дозволений на merge у `develop` для дрібних feature; у `main` —
  зберігати читабельну історію (merge commit per зріз).
- Тимчасові тестові зміни (напр. час 01–23) **позначати в комітах і PR** як
  тимчасові, з нагадуванням відкотити (`feature/production-time`).

### 17.4 Чек-лист «крок завершено»

`typecheck` ✓ · відповідні тести ✓ · lint ✓ · **локальний** коміт через
`commit-commands` (Conventional) ✓. Тільки тоді — наступний крок.
**Push — НЕ на кроці, а в кінці ЗРІЗУ** (потім PR у `develop`) (§17.2).

---

## 18. Тулінг і налаштування репо (project settings)

- **`.nvmrc`** — пін Node LTS.
- **`.gitattributes`**: `* text=auto eol=lf` — однакові закінчення рядків між OS
  (Windows-дев + Linux-CI), стабільні діфи (§19.8).
- **`.editorconfig`** — відступи, кодування UTF-8, фінальний newline.
- **ESLint + Prettier** — узгоджений стиль; `lint` у npm-scripts і в CI.
- **`tsconfig.json`**: `strict`, ESM (`NodeNext`), `types: ["node"]`,
  `isolatedModules: true`.
- **npm scripts**: `build`, `typecheck`, `lint`, `test`, `dry-run`. **`test`
  має працювати на Windows** — викликати `node_modules/jest/bin/jest.js`, не
  `.bin/jest` (§19.9). Розглянути `vitest` як крос-платформну альтернативу.
- **Pre-commit (husky + lint-staged)**: на коміт — `typecheck` + `lint` +
  швидкі тести. Гарантує «зелений» кожен коміт (§17.2). Не блокувати
  `[skip ci]`-коміти стану від бота.
- **CI (`ci.yml`)** на PR у `develop`/`main`: `npm ci` → `typecheck` → `lint` →
  `test` → security-review. Actions пінити по SHA.
- **`brief.yml`** (продакшн-джоба): §2 (concurrency, permissions, guard-gate
  через `scripts/guard.mjs` на системному node, dispatch-force). Працює з гілки
  **`state`** і туди ж пушить `state.json` (§4.3). Бот має git-identity:
  `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` (напр. `svitanok-bot`).
- **`.env.example`** — усі змінні з коментарями; локальний рантайм валідує
  наявність і падає явно (рання валідація критичних — §4.1 п.0).

### 18.1 Продуктивність Claude Code-сесій (ліміти/ресурси)

> Узгоджено з власником 2026-07-09. Ціль — менше витрати ліміту без втрати якості.

- **Розвідка — через субагента, не інлайн.** Перед розширенням незнайомого
  модуля, реверс-інжинірингом дизайн-файлів (Claude Design `.dc.html`) або
  крос-файловою звіркою контракту («чи поле X консистентне в типі + рендері +
  sample-даних?») — використовувати субагента `.claude/agents/svitanok-explore.md`
  (або вбудований `Explore`), а не тягнути сирі дампи файлів у головний контекст.
  НЕ делегувати: самі правки коду, PR/commit-описи (тісно пов'язані з поточним
  діфом — делегування дорожче), одноразові читання одного файлу.
- **Без скріншотів у верифікації.** Власник має власний preview-режим і бачить
  результат сам. Верифікувати функціонально — `preview_eval`/консоль/мережа —
  без `preview_screenshot`.
- **Тести пакетами.** Гонити typecheck/vitest після завершення логічного шматка
  правок, а не після кожної окремої правки.
- **Модель — Sonnet за замовчуванням.** Opus — лише для точкових архітектурних
  рішень (вибір стратегії, аналіз перф/безпеки), не для рутинної імплементації.
- **Довгі сесії — новий чат на новий блок роботи.** Один величезний тред, що
  накопичує історію багатьох завершених задач, дорожчий за старт нової сесії
  на кожен великий етап роадмепу.
- **CI-очікування** — одним блокуючим `gh pr checks <N> --watch` замість циклів
  ручного sleep+poll.
- **TypeScript 7** (нативний Go-компілятор, GA 2026-07-08) — НЕ переходити,
  доки `typescript-eslint` офіційно не підтримає TS7 без обхідного
  `@typescript/typescript6`-аліасингу (наразі API компілятора в 7.0 відсутнє).
  Переглянути рішення, коли з'явиться офіційна підтримка.

---

## 19. Граблі, яких більше НЕ повторюємо (підсумок попередньої ітерації)

> Кожен пункт — реальний баг минулої збірки. У новому коді закладається зразу.

### 19.1 Guard — єдине джерело істини (один скрипт, нуль дублювання)

Раніше guard був **і** в YAML (захардкоджені 8/4) **і** в оркестраторі — вони
розійшлися: YAML скіпав джобу за хардкодом, ігноруючи `config.yml`, і ручний
запуск опівдні тихо нічого не слав. **Тепер:** логіка вікна — в одному місці
(`core/guard.ts`), а CI-гейт викликає її через `scripts/guard.mjs` на
**системному node** runner-а (передвстановлений на `ubuntu-latest`, `npm ci` не
потрібен — тож і дешево, і рано). **Жодного парсингу/порівняння в bash** — YAML
лише запускає скрипт і читає його exit-код/output. Так усувається сам клас
розсинхрону, а не лише його число.

### 19.2 workflow_dispatch завжди форсує

Ручний запуск через `workflow_dispatch` має слати **завжди** (`--force`),
обходячи вікно й ідемпотентність. Інакше тестувати поза ранковим вікном
неможливо. YAML передає `--force` коли `github.event_name == 'workflow_dispatch'`.

### 19.3 Telegram-діагностика — обов'язковий артефакт

«Бот мовчить» через невірний `chat_id` / не натиснутий Start з'їв ітерацію.
`scripts/check-telegram.mjs` (getMe/getUpdates/sendMessage) має бути **з першого
дня**, до будь-якого CI.

### 19.4 API-ключ не витікає в URL

OpenWeather тримає ключ у query (`appid=...`). Канонізація/логи **мусять
зрізати** `appid` (та `apikey/api_key/token/...`). Тест на це обов'язковий.

### 19.5 Повний config у Ctx

Передача модулю лише `config.modules` ховала `config.locations` тощо й давала
рантайм-краш. Модулю передається **повний** конфіг, кожен типізує свій зріз.

### 19.6 zod-ліміт під тестовий період

`sendWindowHours` мусить допускати до **23** (тестовий період 01–23). Інакше
валідація падає на старті. Інваріант `sendHour + sendWindowHours <= 24`.

### 19.7 Тільки execFile/spawn, ніякого exec-склейки

Git-коміт стану та будь-які зовнішні виклики — `execFile` з масивом аргументів.
Жодних shell-рядків з конкатенацією (інʼєкція + крос-платформні баги).

### 19.8 Закінчення рядків (CRLF/LF)

Windows-дев + Linux-CI без `.gitattributes` дають шумні діфи й «зміни» там, де
їх нема. `* text=auto eol=lf`.

### 19.9 Jest на Windows

`node node_modules/.bin/jest` падає на Windows (це sh-скрипт). Викликати
`node_modules/jest/bin/jest.js`. Або перейти на `vitest`.

### 19.10 Default-гілка main

Репо й уся робота — на `main`, ніколи `master`.

### 19.11 Календарний DST у межах дня

`timeMin`/`timeMax` для Google Calendar НЕ хардкодити `+03:00` — узимку Київ
`+02:00`, інакше «сьогоднішні» події зсуваються/обрізаються. Будувати межі дня
через коректну TZ `Europe/Kyiv` (обчислений поточний офсет / `Intl`), не
фіксований рядок. Тест на зимову й літню дату (§13).

### 19.12 Тиха відмова без критичних секретів

Якщо немає самого `TELEGRAM_BOT_TOKEN`/`CHAT_ID` — top-level fail-notify теж
нічим не надішле, і збій стане **німим** (той самий клас, що §19.3). Тому —
рання валідація критичних секретів і завершення **видимим failed-раном**
(ненульовий код), а не тиха зупинка (§4.1 п.0, §8).

### 19.13 Захист main vs щоденний стан (ЗАСТАРІЛО — стан у KV)

**Історично:** бот щодня пушив `state.json` у незахищену гілку **`state`**, щоб
захищений `main` (лише через PR) це не блокував.

**Тепер (Фаза F):** стан живе в **Cloudflare KV** (ключ `state`), оркестратор
пише напряму через CF API (`brief.yml`), Worker — через binding. Жодного
git-коміту стану немає. Гілку `state` **видалено** як мертву (`main` лишається
захищеним і лінійним без окремої гілки стану).

### 19.14 React-дашборд (роадмеп v3, група E)

Mini App мігрує з рукописного `web/public/index.html` на **React+Tailwind**.
Окремий toolchain у `web/app/` (Vite+React+TS+Tailwind v4, власний
`package.json`), білдиться у `web/public/app/` — жива версія на **`/app`** поруч
зі старим `index.html` на `/`, який лишається недоторканим до фінального
перемикання (E4). Артефакт (`web/public/app/`) **не комітиться** (`.gitignore`);
CI білдить його окремою job `dashboard` (ловить поломки), а деплой:
`npm --prefix web/app run build` → `wrangler deploy` з `web/`. Стек — якісний
(TanStack Query для даних/рефетчу, Zod для валідації контрактів, Framer Motion
для анімацій, @dnd-kit для drag&drop воронки у групі F), не «мінімум залежностей».
Контракти `/api/*` і `briefing.json` **незмінні** — Worker не чіпаємо.

---

## Дод. A. Ідеї поза MVP

- Health-блок раз на тиждень (погода ок, календар ок, новин N, токен живий N днів).
- Кеш установки claude CLI у workflow.
- Динамічна локація у фазі B (надсилаєш боту геопозицію → у `state.json`).
- Прунинг `state.json` тримає файл і коміти стрункими.
