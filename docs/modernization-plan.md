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
- [x] Перенести `state` і `stats` у single-writer `StateStoreDO` із versioned CAS; KV лишити compatibility snapshot-ом.
- [x] Перенести active `agentRuns` у RunRegistryDO: delivery context зберігається поруч із run; KV-blob лишився лише для rollback/старої конфігурації та очищення rollout-решток.
- [x] Перенести `assistantPending` у PendingProposalsDO: CAS для циклічних кнопок і атомарний claim перед Calendar/People write; KV — лише seed/mirror для rollback.
- [ ] Перенести решту structured concurrent state у D1 transactions/event tables або окремий single-writer Durable Object.
- [ ] Залишити KV тільки для cache/latest briefing/config/immutable snapshot після повного inventory всіх ключів.
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
- [ ] Деплой переходить на immutable release directory + atomic switch.
- [ ] Ввести expand/contract D1 migrations і release manifest для Worker/brain/instructions/tool schema.
- [ ] Прибрати legacy health probes і, після soak/rollback checkpoint, legacy host path.
- [ ] Додати smoke contract і restore drill automation.

**Готово, коли:** під час релізу немає неконтрольованої code/schema/prompt несумісності; статус не видає configured за healthy.

### 1F. Безпечний Mini App failure UX і delivery performance

- [x] Замість sample personal data на 401/403 показувати blocking session-expired state.
- [x] Лишити demo тільки поза Telegram через явний demo switch; ніколи як auth fallback.
- [x] Додати route-level code splitting і build-enforced bundle budget (300 KB minified на JS chunk).
- [ ] Зробити runtime smoke/performance test у реальному Telegram WebView після контрольного деплою.
- [x] Перевірити focus/accessibility/error state після зміни auth flow.

## Фаза 2 — тестування, observability і документація

- [ ] Workerd/Miniflare integration tests для DO alarms, D1, KV, Workflows, `waitUntil`, assets.
- [ ] Fake Telegram/Google/Mono E2E tests.
- [ ] Fault injection для timeout, duplicate delivery, D1/Vectorize/API failures.
- [ ] Run dashboard: terminal state, retry, queue wait, tool latency, policy decision, model/version, cost.
- [ ] Reminder and briefing delivery SLOs.
- [ ] Backup → clean restore → semantic comparison drill.
- [ ] Генерований tool/policy/schema contract або contract tests, що не дають docs розійтися з кодом.
- [ ] Оновити canonical docs після кожної завершеної підсистеми.

## Фаза 3 — provider-neutral AI runtime і OpenAI Responses

**Контракт:** `ToolSpec`, input/output schema, policy level, provenance rules, profile, timeout, max tool calls, cost/latency budget створюються один раз і адаптуються до Claude/OpenAI.

- [ ] Виділити provider-neutral `ModelRuntime` та canonical tool registry без зміни поточної policy boundary.
- [ ] Додати OpenAI Responses adapter із `store:false`, hashed `safety_identifier`, strict custom function tools і явним model config.
- [ ] Не передавати credentials у Responses; кожен tool call повертається до Cloudflare core.
- [ ] Зберігати власну session/memory truth у D1; не робити provider conversation source of truth.
- [ ] Записувати response ID, model snapshot, usage, latency, tool calls у run telemetry без персональних prompt dumps.
- [ ] Створити redacted eval suite: intent, tool selection, policy, injection, Ukrainian response quality, refusal/uncertainty, memory conflict.
- [ ] Запустити shadow mode лише для read-only cases; порівняти quality, tool correctness, latency, cost.
- [ ] Canary fast lane, потім chat/reasoning lane; rollback через config.
- [ ] Prototype Cloudflare Workflow orchestration для одного profile; переносити VPS workloads лише після вимірювання.

**API policy:** current official OpenAI documentation says Responses supports custom functions, built-in tools, structured outputs, streaming and background mode; `store` defaults to true, so personal runs set it explicitly to false. Built-in web/file tools are opt-in and follow Svitanok's taint/citation rules. Source: [Create a response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

**Initial model policy:** model ID is configuration, not architecture. The current official resolver identifies `gpt-6-astra` as the latest migration target; the adapter keeps it configurable and begins with the lowest-risk read-only/evaluated workload. Current migration guidance requires the Responses API for tool calling and recommends preserving effective reasoning effort while testing changes ([official model guidance](https://developers.openai.com/api/docs/guides/latest-model)).

## Фаза 4 — продуктові capabilities після foundation

### 4A. Decision-centred daily briefing

- [ ] Critical deterministic layer: reminders, calendar conflicts, important email/job signal, time-sensitive weather.
- [ ] AI summary/ranking as non-critical enhancement with source/freshness/reason.
- [ ] Per-block feedback: useful / less / hide.
- [ ] Measure open, action, save, dismiss; remove noisy blocks.

### 4B. Smart Job Hunter

- [ ] Rename current title-only number to relevance, until evidence is available.
- [ ] Fetch/store permitted job descriptions with source/freshness.
- [ ] Evidence dimensions: stack, level, location, language, salary, dealbreakers, missing skills, confidence.
- [ ] Funnel: seen → saved → applied → interview → offer; learn only from explicit outcomes.

### 4C. Email Attention

- [ ] Read-only attention view built from deterministic urgency signals plus constrained summary.
- [ ] Keep mail content tainted; citations/message links and no automatic send.
- [ ] User confirmation for every reply/archive/external effect.

### 4D. Personal Analytics and learning

- [ ] Separate facts, statistical patterns, hypotheses and recommendations in UI/API.
- [ ] Start with deterministic metric queries; AI explains only provided aggregates.
- [ ] Instrument learning attempts/errors before adaptive coach.

### 4E. Narrow Personal Knowledge Base

- [ ] Allowlist first: CV, job preparation and chosen learning documents.
- [ ] Versioned extraction/chunking/citations/ACL, D1 truth and Vectorize projection.
- [ ] Retrieval answers cite document/version/page; explicit delete/revoke.
- [ ] Compare managed file search only as an isolated, privacy-reviewed experiment.

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
