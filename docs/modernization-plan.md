# План модернізації Svitanok

**Гілка:** `feature/svitanok-modernization`
**Baseline tag:** `svitanok-pre-modernization-2026-09-16` (`02d8372`)  
**Статус:** виконується

Це один план для всієї гілки, а не перелік незалежних ідей. Кожна зміна має зберігати або посилювати наведені нижче інваріанти. Фази виконуються послідовно; нова AI-функція не обходить незавершену безпекову чи reliability-роботу.

## Незмінні інваріанти

1. Cloudflare core є єдиним авторитетом для auth, policy, tools і external writes.
2. LLM інтерпретує намір та обирає інструмент, але не отримує прямих Google/Telegram/Mono credentials.
3. T0/T1/T2 зберігається; tainted або inferred дані не можуть непомітно створити persistent факт чи зовнішню дію.
4. Кожна команда/run/tool/delivery безпечно повторюється. Повтор не створює другу зовнішню дію і не блокує queue.
5. D1 — source of truth для structured mutable data; KV — cache, config або immutable/latest snapshot, не конкурентний RMW state.
6. Пам'ять має provenance, owner precedence, expiry/review і контроль користувача.
7. `forget` видаляє або явно декларує всі копії персональних даних.
8. Деплой сумісний: schema, Worker, prompt/tool contract і brain release не можуть мати неконтрольовану несумісну комбінацію.
9. Кожен ризиковий перехід має тест, observable event і rollback.
10. Production не деплоїться в межах цієї роботи без окремого явного запиту власника.

## Фаза 0 — baseline і контракт змін

- [x] Створити annotated Git tag поточної версії.
- [x] Створити одну робочу гілку.
- [x] Оформити незалежний аудит.
- [x] Зафіксувати цей план і аудит першим commit на робочій гілці.
- [ ] Усі наступні commits робити атомарними за підсистемою та з тестами.

## Фаза 1 — correctness, безпека і дані

### 1A. Надійний життєвий цикл run

**Проблема:** `registryBegin`/`registryFinish` і brain run report мають best-effort шляхи, хоча вони просувають queue та workflow.

**Робота:**

- [x] Описати run state machine та інваріанти в `docs/run-lifecycle.md`.
- [x] Зробити start атомарним: brain не стартує, доки RunRegistry не підтвердив run.
- [x] Винести authoritative completion з telemetry endpoint.
- [x] Додати короткий idempotent completion window, terminal state і безпечний retry.
- [x] Додати унікальність `(run_id, n)`/upsert для `run_steps`.
- [x] Зробити queue advance незалежним від помилки telemetry.
- [x] Додати retry/backoff для фінального report; reconciliation для незавершених run лишається окремим пунктом observability.
- [x] Тести: D1 error під час telemetry, duplicate completion, failed begin, quick→chat escalation; окремий E2E delayed-delivery test буде у Фазі 2.

**Готово, коли:** кожен прийнятий run доходить до terminal state, а повтор будь-якого internal повідомлення не створює другу дію й не залишає thread заблокованим.

### 1B. Mutable state без KV race conditions

**Проблема:** read-modify-write JSON у KV не дає atomicity між webhook, scheduler і Actions.

**Робота:**

- [x] Інвентаризувати `state`/`stats`: обидва мали конкурентних writers і стали першим міграційним зрізом.
- [x] Зафіксувати повний [KV inventory](kv-inventory.md): кожен ключ класифікований як canonical control plane, cache/config, idempotency marker або окрема scheduler-only state machine з умовою міграції.
- [x] Перенести `state` і `stats` у single-writer `StateStoreDO` із versioned CAS; KV лишити compatibility snapshot-ом.
- [x] Перенести `settings` у StateStoreDO: Mini App, Telegram-пропозиції й policy-патчі мають CAS; KV лишився mirror для оркестратора.
- [x] Перенести active `agentRuns` у RunRegistryDO: delivery context зберігається поруч із run; KV-blob лишився лише для rollback/старої конфігурації та очищення rollout-решток.
- [x] Перенести `assistantPending` у PendingProposalsDO: CAS для циклічних кнопок і атомарний claim перед Calendar/People write; KV — лише seed/mirror для rollback.
- [x] Перенести `sentMessages` у SentMessagesDO: atomic `record`/`forget` для webhook, cron, outbox і `/clear`; KV — лише seed/mirror для rollback та старого backup формату.
- [x] Перенести `assistantHistory` у AssistantHistoryDO: callback-питання й agent exchange дописуються atomic batches; 30-денний TTL виконує DO alarm, KV — seed/mirror для rollback та старого export формату.
- [x] Перенести `assistantResume:*` у AssistantResumeDO: паралельні повідомлення можуть списати continuation slot лише раз; 30-хвилинний alarm і T2 не дозволяють legacy mirror воскресити контекст.
- [x] Перенести `briefDispatch` у BriefDispatchDO: manual `/brief` і п'ятихвилинний cron беруть atomic lease до зовнішнього GitHub workflow; KV — лише compatibility seed/mirror після підтвердженого dispatch.
- [x] Перенести `weatherLiveCounter` у WeatherQuotaDO: повна пачка OpenWeather calls резервується до fetch, тому concurrent cache miss не перевищує денну квоту; `weatherLive` лишається KV cache.
- [x] Перенести `inboxDayCount` у InboxQuotaDO: паралельні Business-вебхуки атомарно резервують D1 inbox row, а перевищення денного cap надсилає лише один alert; KV лишається compatibility mirror.
- [x] Перенести `agentHostHealth` у AgentHostHealthDO: конкурентні VPS health probe можуть прийняти перехід і owner alert лише один раз; KV лишається status mirror.
- [x] Перенести `monoReconcile` у MonoReconcileDO: lease охоплює один зовнішній Mono-крок, а progress commit належить лише власнику lease; KV лишається rollback mirror.
- [x] Перенести `backupState` у BackupStateDO: один lease володіє weekly Drive backup attempt, а retryable збій звільняє його для наступного tick; KV лишається rollback mirror.
- [x] Перенести `weeklyReviewState` у WeeklyReviewStateDO: lease серіалізує старт, retry та фінальний alert weekly report; KV лишається rollback mirror.
- [x] Перенести `monoUnknownAlert` у MonoAlertGateDO: паралельні Mono webhooks атомарно беруть добове право на owner alert; KV лишається compatibility mirror.
- [x] Перенести Steam daily check у SteamCheckStateDO: один lease володіє зовнішнім ITAD run, failure streak і sale transition; KV лишається compatibility mirror.
- [x] Перенести решту structured concurrent state у D1 transactions/event tables або окремий single-writer Durable Object.
- [x] Залишити KV тільки для cache/latest briefing/config/immutable snapshot або compatibility mirror після повного inventory всіх ключів.
- [x] Ввести одноразовий seed із legacy KV, canonical read та compatibility fallback для rollback/local tests.
- [x] Concurrency tests із паралельними writers і retry для `state`/`stats`; додати такі тести до кожної наступної міграції.

**Готово, коли:** жодна критична user-facing state transition не залежить від KV RMW.

### 1C. Пам'ять, taint і provenance

**Проблема:** inferred/tainted `facts.set` може замінити owner-confirmed факт; D1 і Vectorize оновлюються неатомарно.

**Робота:**

- [x] Розділити `owner assertion`, `observed event`, `model hypothesis` у схемі та API; legacy `owner`/`inferred` нормалізуються сумісно.
- [x] Додати `source`, `confidence`, `observed_at`, `expires_at/review_at`, `supersedes`; зберегти metadata при legacy upsert/undo та не дозволяти моделі видавати гіпотезу за `observed_event`.
- [x] Заборонити inference overwrite owner fact без T1 proposal.
- [x] Ескалювати `facts.set` із tainted external context до T1 proposal.
- [x] Пропускати provenance/taint від tool output до tool arguments для всіх persistent write (trusted `policy` context, що переживає proposal).
- [x] Перетворити Vectorize на rebuildable projection: `pending → indexed → ready`, versioned rows, scheduler reconciliation, rebuild із D1 та cleanup retired vectors ([contract](memory-projection.md)).
- [x] Додати owner-facing memory ledger: why/source/edit/delete ([contract](fact-ledger.md)).
- [x] Tests: prompt injection з email/web, owner precedence, stale fact, partial vector failure, rebuild.

**Готово, коли:** модель не може непомітно погіршити факти, а семантичний індекс можна відновити без втрати D1 truth.

### 1D. Реальне видалення даних і retention

**Проблема:** `forget` не підтверджує cleanup VPS SDK transcripts, queues і старих backup copies.

**Робота:**

- [x] Створити data inventory і retention matrix для D1/KV/Vectorize/VPS/Drive/queues/logs (`docs/data-retention.md`).
- [x] Зробити T2 deletion workflow з durable KV-receipt, abort активних run і scheduler reconcile без другого підтвердження.
- [x] Реалізувати 90-day cleanup VPS SDK-транскриптів та Vectorize → D1 порядок із інтеграційними тестами.
- [x] Визначити policy encrypted backups: точні app-owned файли зберігаються 90 діб, далі та при T2 — безповоротний Drive purge.
- [x] Додати read-only UI/status report історії квитанцій і помилок видалення.

**Готово, коли:** UI/API може чесно показати, що саме видалено, що ще зберігається і до якої дати.

### 1E. Health, release і operational truth

**Робота:**

- [x] `/status` показує окремо configured/reachable/version match/freshness health-проби/active runs; configured не видається за healthy.
- [x] Додати до `/status` model readiness і час останнього успішного non-shadow run.
- [x] Brain має `/ready`, drain, versioned `/health` і deploy-safe graceful shutdown.
- [x] Підготувати immutable release directory + atomic switch; activation очікує одноразового VPS bootstrap, який не виконується з цієї гілки.
- [x] Ввести expand/contract D1 migrations і release manifest для Worker/brain/instructions/tool schema.
- [ ] Прибрати legacy health probes і, після soak/rollback checkpoint, legacy host path.
- [x] Додати smoke contract і non-destructive clean restore drill automation.

**Готово, коли:** під час релізу немає неконтрольованої code/schema/prompt несумісності; статус не видає configured за healthy.

### 1F. Безпечний Mini App failure UX і delivery performance

- [x] Замість sample personal data на 401/403 показувати blocking session-expired state.
- [x] Лишити demo тільки поза Telegram через явний demo switch; ніколи як auth fallback.
- [x] Додати route-level code splitting і build-enforced bundle budget (300 KB minified на JS chunk).
- [ ] Зробити runtime smoke/performance test у реальному Telegram WebView після контрольного деплою.
- [x] Перевірити focus/accessibility/error state після зміни auth flow.

## Фаза 2 — тестування, observability і документація

- [x] Workerd/Miniflare integration tests для DO alarms, D1, KV, Workflows, `waitUntil`, assets.
- [x] Fake Telegram/Google/Mono E2E tests.
- [x] Fault injection для timeout, duplicate delivery, D1/Vectorize/API failures.
- [x] Run dashboard: terminal state, retry, queue wait, tool latency, policy decision, model/version, cost.
- [x] Reminder and briefing delivery SLOs.
- [x] Backup → clean restore → semantic comparison drill.
- [x] Генерований tool/policy/schema contract або contract tests, що не дають docs розійтися з кодом.
- [x] Оновити canonical docs після кожної завершеної підсистеми.

## Фаза 3 — provider-neutral AI runtime і OpenAI Responses

**Контракт:** `ToolSpec`, input/output schema, policy level, provenance rules, profile, timeout, max tool calls, cost/latency budget створюються один раз і адаптуються до Claude/OpenAI.

- [x] Виділити provider-neutral `ModelRuntime` та canonical tool registry без зміни поточної policy boundary.
- [x] Додати OpenAI Responses adapter із `store:false`, hashed `safety_identifier`, strict custom function tools і явним model config.
- [x] Не передавати credentials у Responses; кожен tool call повертається до Cloudflare core.
- [x] Зберігати власну session/memory truth у D1; не робити provider conversation source of truth.
- [x] Записувати response ID, model snapshot, usage, latency, tool calls у run telemetry без персональних prompt dumps.
- [x] Створити redacted eval suite: intent, tool selection, policy, injection, Ukrainian response quality, refusal/uncertainty, memory conflict (`npm run eval:openai`; явний read-only запуск, без PII або ключа в repo).
- [ ] Запустити shadow mode лише для read-only cases; порівняти quality, tool correctness, latency, cost.
- [ ] Canary fast lane, потім chat/reasoning lane; rollback через config.
- [ ] Prototype Cloudflare Workflow orchestration для одного profile; переносити VPS workloads лише після вимірювання.

**API policy:** current official OpenAI documentation says Responses supports custom functions, built-in tools, structured outputs, streaming and background mode; `store` defaults to true, so personal runs set it explicitly to false. Built-in web/file tools are opt-in and follow Svitanok's taint/citation rules. Source: [Create a response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

**Initial model policy:** model ID is configuration, not architecture. The current official resolver identifies `gpt-6-astra` as the latest migration target; the adapter keeps it configurable and begins with the lowest-risk read-only/evaluated workload. Current migration guidance requires the Responses API for tool calling and recommends preserving effective reasoning effort while testing changes ([official model guidance](https://developers.openai.com/api/docs/guides/latest-model)).

## Фаза 4 — продуктові capabilities після foundation

### 4A. Decision-centred daily briefing

- [x] Critical deterministic layer: reminders, calendar conflicts, important email/job signal, time-sensitive weather. Worker snapshots both reminder stores and calendar intervals before dispatch; the briefing emits only dated, source/freshness/reason-tagged signals and never promotes an incomplete production snapshot.
- [x] AI summary/ranking as non-critical enhancement with source/freshness/reason. It sees only bounded deterministic signal records, must return valid existing IDs, and is silently omitted on timeout/error/malformed output.
- [x] Per-block feedback: useful / less / hide. Власник може сказати це
      асистенту для allowlisted блока; `hide` прибирає лише повний блок, не
      critical decision headline, `less` стабільно опускає блок нижче, а
      `useful` повертає його. Запис T0 має undo, після tainted external content
      ескалується до T1. Mini App не змінювалась.
- [x] Measure open, action, save, dismiss; remove noisy blocks. Backend keeps
      only bounded daily aggregates per allowlisted block (no briefing text,
      URLs or titles): latest-briefing open, existing action/save/dismiss
      events and explicit `hide`. `data.read(scope=briefing)` exposes 30-day
      candidates for `less` after at least seven shown days without interaction;
      it never changes visibility automatically. Mini App is unchanged.

### 4B. Smart Job Hunter

- [x] Rename current title-only number to explicit title relevance, until evidence is available (UI now says `за заголовком`, not fit; model prompt prohibits claims about missing description fields).
- [x] Fetch/store permitted job descriptions with source/freshness. Лише URL із
      configured RSS, які збіглися з точними `https` host+pathPrefix правилами,
      можуть бути page-fetched; кожен redirect перевіряється повторно. У state
      лишається максимум 60 нормалізованих public excerpts на 14 діб із source і
      fetchedAt; HTML і текст не йдуть у LLM чи Mini App. Title relevance ще не
      перетворюється на оцінку повного опису.
- [x] Evidence dimensions: stack, level, location, language, salary,
      dealbreakers, missing skills, confidence. Backend emits only deterministic
      facts with source/confidence; `requiredStack` is explicit requirement
      context, `missingSkills` means “not present in profile text”, and a
      dealbreaker is only an explicit mismatch with an explicit profile target.
      The frozen Mini App safely ignores this future-facing snapshot field.
- [x] Funnel: `seen → saved → applied → interview → offer` is a separate
      backend `jobFunnel` window: `seen` is written only after the owner opens
      the current briefing, is capped to 250 public URL/title records for 30
      days, and never changes `jobPrefs`. Existing Mini App stages stay
      unchanged; the assistant can read the aggregate. Recommendation learning
      remains limited to explicit `dismiss`, `applied`, `interview`, and
      `offer` outcomes — never exposure, `rejected`, or `failed`.

### 4C. Email Attention

- [x] Read-only attention view built from deterministic urgency signals plus a
      bounded aggregate summary. It exposes at most 20 owner-visible headers,
      never body/snippet, and explicitly reports its read-only/tainted mode.
- [x] Keep mail content tainted; each item has a validated Gmail message
      citation/link, while assistant mail reads use external taint markup.
      `gmail.send`/`gmail.modify` are absent from scopes and there is no send,
      reply, archive, or external-effect endpoint.
- [x] User confirmation for every reply/archive/external effect: these mail
      effects are currently unavailable by capability; any future write must
      enter the existing T1 proposal policy rather than bypass it.

### 4D. Personal Analytics and learning

- [x] Separate facts, statistical patterns, hypotheses and recommendations in API.
      `GET /api/analytics` is owner-only, `no-store`, and deliberately separate
      from frozen Mini App `/api/stats`: a future screen can consume it without
      changing the current Mini App contract. A statistical pattern is always
      marked `association_not_causation`; a pre-registered hypothesis without a
      shown row is `not_shown`, never a fabricated negative conclusion.
- [x] Start with deterministic metric queries; AI explains only provided aggregates.
      `data.read(scope=analytics)` and legacy `readOwnData(analytics)` receive
      the same bounded snapshot built from `aggregateStats` plus the weekly
      `levers` cache. There is no analytics LLM call, raw check-in, or automatic
      plan mutation; recommendations can only ask the owner to continue one
      week of measurement.
- [x] Instrument learning attempts/errors before adaptive coach. Explicit owner
      reports only (`correct|incorrect|unsure`) are idempotent by attempt id
      (the assistant derives it from its run id), retain a short topic label and
      date for 90 days (max 180), and aggregate by topic.
      `mock_answer` remains a self-reported difficulty signal, never silently
      converted into correct/incorrect. No adaptive coach or automatic learning
      intervention is enabled by this instrumentation.

### 4E. Narrow Personal Knowledge Base

- [x] Allowlist-first foundation: CV, job preparation and chosen learning documents; every source is added explicitly, not discovered from Drive.
- [x] Versioned extraction/chunking/citations/ACL: D1 truth, rebuildable Vectorize projection і retry pending/failed версій.
- [x] Retrieval answers cite document/version/page; explicit delete/revoke.
- [x] Explicit one-file Drive import: inspect metadata → T1 → repeated version/MIME check → bounded UTF-8 text extraction. No search/list/crawl route, and Google Docs/.txt/.md only.
- [ ] Compare managed file search only as an isolated, privacy-reviewed experiment.
      A synthetic-only, explicitly opt-in harness now verifies hosted API and
      cleanup semantics without reading owner data; it is not a production
      integration or a quality result. A real-document comparison still needs
      a separate owner decision naming the allowed fixture and retention
      boundary ([contract](managed-file-search-experiment.md)).

**Памʼять / production-дія перед першим живим імпортом:** після деплою
перевидати Google OAuth refresh token через `node scripts/google-auth.mjs`,
погодивши новий вузький scope `drive.readonly`, і оновити лише
`GOOGLE_REFRESH_TOKEN` у Cloudflare. Без цього `knowledge.inspect/import`
чесно відмовляться, а не читатимуть Drive за старим токеном.

### Deferred

- Autonomous email replies, job applications and calendar writes.
- Whole-Drive/whole-mail ingestion.
- Always-on web search.
- Multi-agent swarm by default.
- Generic image generation without a measured workflow.

## Execution discipline

For each checkbox group:

1. Read current code and tests; write/update the narrowest design contract.
2. Implement compatibility-first changes and migrations.
3. Add failure/concurrency/security tests before claiming completion.
4. Run relevant tests, then full checks when shared boundaries change.
5. Update this checklist and canonical docs in the same commit.
6. Do not deploy or rotate external secrets without an explicit production request.

## Completion criteria

The branch is ready for production review when all Phase 1–3 items are complete, feature work passed its own acceptance metrics, test/restore/eval evidence is attached, docs match code, and the release manifest identifies a reversible version set.
