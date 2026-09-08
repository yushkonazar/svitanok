# 03 · План розробки

Правила (з `01`, ADR-030, ADR-009 без staging): кожен етап = гілка(и) `feature/*` → PR у `develop` → PR у `main` (прод, новий код за прапорцем `ASSISTANT_V2=off`) → приймання чеклістом у проді (`shadow`, потім `on`). Один логічний коміт на зміну, Conventional Commits українською, без згадок асистентів-помічників у коді/комітах/PR. Перед PR - `/code-review` і `/security-review`; перед мержем у main - `/code-review` ще раз. Green gate = команди з CI-воркфлоу (typecheck, lint, tests). Оцінки - людино-дні з Claude Code (INFERRED).

Структура репозиторію після редизайну:

```
web/                 Worker (ядро) - чинні модулі + web/core/**
web/core/            gateway, prerouter, thread-queue, policy, tools/, adapters/, tg, scheduler, run-registry, workflows/, memory, instructions, migrations/
brain/               TypeScript-сервіс мозку (замість host/)
docs/assistant/      persona.md, agents/, checklists/, weekly-review.md   (джерело інструкцій)
docs/ops/            runbooks (секрети, деплой, відновлення)
.github/workflows/   brief.yml (є), deploy-host.yml, idea-analysis.yml, sync-instructions.yml, ci.yml (є)
tests/               unit + scenario + contract
```

## Етап 0 · Підготовка (власник, без коду) - 1 день

| #    | Дія                                                                                                                                                                                                                                                                                                            | Де                                        | Результат                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| 0.1  | Увімкнути Workers Paid                                                                                                                                                                                                                                                                                         | Cloudflare dashboard                      | $5/міс                                        |
| 0.2  | Google Cloud-проєкт «svitanok-apis» з білінгом; API: Places (New), Routes, Geocoding; ключ, обмежений трьома API; стелі квот per day (SearchText 150, GetPlace 30, Routes 300) + бюджет $5 з алертами. Gemini-ключ - НЕ тут: створюється в AI Studio з передплатою $10 (VERIFIED 24.08) - відкладено на етап 7 | console.cloud.google.com                  | `MAPS_API_KEY`                                |
| 0.3  | Перевірити OAuth-застосунок Світанку: статус «In production»; додати скоупи `drive.file` і `tasks`; перевидати refresh-токен через `stage0/google-auth.mjs` (кладеться в CF на етапі 2 разом із `on`; до того чинний токен працює)                                                                             | console (APIs & Services → OAuth consent) | статус + 1 токен                              |
| 0.4  | Перевірити перемикач «Model improvement» у claude.ai - вимкнено                                                                                                                                                                                                                                                | claude.ai/settings                        | підтвердження                                 |
| 0.5  | Claude-токен: використовуємо чинний (`host/.env` на VPS, дійсний до ~06.2027); новий не потрібен                                                                                                                                                                                                               | -                                         | закрито 24.08                                 |
| 0.6  | Deepgram: акаунт, ключ (кредит $200)                                                                                                                                                                                                                                                                           | deepgram.com                              | `DEEPGRAM_API_KEY`                            |
| 0.7  | IsThereAnyDeal: акаунт, ключ                                                                                                                                                                                                                                                                                   | isthereanydeal.com/apps                   | `ITAD_API_KEY`                                |
| 0.8  | Monobank: персональний токен                                                                                                                                                                                                                                                                                   | api.monobank.ua                           | `MONO_TOKEN` (вебхук ставить ядро на етапі 6) |
| 0.9  | GitHub: fine-grained PAT read-only (contents) на svitanok, portfolio, moviehouse, modern-blog; deploy-ключ для VPS                                                                                                                                                                                             | github.com/settings                       | `REPO_READ_PAT`, `VPS_DEPLOY_KEY`             |
| 0.10 | Telegram: у чинного бота увімкнено «Secretary mode» (= Business Mode; VERIFIED 24.08 скрін BotFather) - підключення в Telegram → Business → Chatbots на етапі 6                                                                                                                                                | BotFather                                 | ✅ 24.08                                      |
| 0.11 | Cloudflare Zero Trust: Tunnel для VPS (hostname `brain.<домен>` → 127.0.0.1:8788), Access-застосунок Service Auth, Service Token                                                                                                                                                                               | one.dash.cloudflare.com                   | `BRAIN_ACCESS_CLIENT_ID/SECRET`               |
| 0.12 | Git-тег `pre-redesign` на `main`                                                                                                                                                                                                                                                                               | репо                                      | резервна точка                                |

Критерій: нові секрети покладені в Cloudflare Secrets і GitHub Secrets за таблицею `05-ops.md` §2 (`stage0/README.md` - точні команди); стале прибрано (§«Секрети» нижче); `ASSISTANT_V2=off` задано як var; жоден секрет не в чаті/файлах.

## Етап 1 · Ядро - 5 днів

**Мета.** Нова інфраструктура поруч зі старим агентом; старий агент працює без змін.

PR-и (по одному на рядок):

1. `chore(core): D1/DO/Workflows bindings + var ASSISTANT_V2 + міграції 0001-0008` (усі таблиці 07 §1; FTS5-проба; усе за прапорцем `off`).
2. `feat(core): Scheduler DO` - `jobs`, alarm-мультиплексування, ідемпотентність, тік; Cron `*/5` як сторож; замір джитера; у `shadow` - тікає паралельно з `CRON_TASKS`, лише логує.
3. `refactor(cron): перенос 10 задач у планувальник` - `checkReminders`, `agentRunWatchdog`, `agentHostHealthCheck`, `autoBriefDispatch`, `deadMansCheck`, `checkinNudgeCheck`, `sleepNudgeCheck`, `autoTelegramSetup`, `archiveMonthly`, `computeLevers` → види задач; `CRON_TASKS` порожніє.
4. `feat(core): RunRegistry DO + runs телеметрія` (поки для старого агента - лише запис).
5. `feat(core): internal API` (`/internal/*`, Access + HMAC, `run_id` перевірка) + контракти JSON-схем.
6. `feat(core): tools читання` - `data.read` (нові scope `weekly`, кап профільний), `calendar.read`, `mail.search/read`, `drive.search`, `drive.write` (папка «Світанок», скоуп `drive.file` з етапу 0), `geo.last`, `geo.geocode`, `facts.get/set`, маркування `<external>`.
7. `feat(core): tg outbox` (троттлінг, Rich Messages з fallback, документи).
8. `feat(core): policy + proposals` (T0/T1/T2, undo, TTL).
9. `chore(ops): Tunnel + deploy-host.yml` (юніт `svitanok-brain` поруч зі старим `svitanok-llm-host`; старий не чіпається).
10. `feat(core): quota_counters + алерти` (80 %, кредити).

Переноситься: `cron.mjs` → `web/core/scheduler/tasks/*`; `reminders-core` → D1 (міграція KV `reminders` скриптом на етапі 2, поки читання з KV); `agent-run-core` лишається до етапу 2.
Ламається/оновлюється: `tests/worker-cron-isolation.test.ts` → тест планувальника; тести нагадувань - адаптер D1.
Тести: unit - усі задачі планувальника (ізоляція збоїв, dedupe, точність), policy (таблиця рівнів × taint), outbox (429, порядок), internal API (підпис, TTL, невідомий run); contract - JSON-схеми інструментів; scenario - S-0-1, S-0-9, S-0-11.
Приймання (прод, `ASSISTANT_V2=shadow`): (1) `/status` показує планувальник і 10 задач з часом останнього тіку; (2) у `shadow` планувальник логує ті самі задачі, що виконав крон (порівняння в `runs` за добу - без розбіжностей); (3) ручний `POST /internal/tool/data.read` з підписом - 200, без підпису - 401; (4) повідомлення > 4 096 символів із тестового ендпоїнта приходить трьома частинами; (5) Tunnel: `curl` на старий хост з ядра - ок, з інтернету - ні.
Відкат: `ASSISTANT_V2=off` → працює лише `CRON_TASKS` (тримати обидва до кінця етапу 2).

## Етап 2 · Мозок = перша точка користування - 8 днів

**Мета.** Новий асистент відповідає на все, що вмів старий, плюс памʼять, формат, голос, швидка смуга. Перемикання - прапорцем `ASSISTANT_V2=on` після чеклісту в режимі `shadow` (новий шлях відповідає лише на повідомлення з префіксом `v2:` від власника - так чеклист проходиться на робочому боті без впливу на старий агент).

PR-и:

1. `feat(brain): каркас` - TS, `query()` SDK, `/run`, `/health`, профілі `chat`/`quick`, MCP-сервер інструментів (Zod ↔ JSON-схеми ядра, тест парності), хуки (PreToolUse taint/рівні, PostToolUse кроки, Stop deliver), стрімінг → `/internal/status`, abort.
2. `feat(brain): сесії` - `resume` за тредом, `/clear`, `sessions` у D1, згортка 04:00, `memory_chunks` + Vectorize (ембединги; якщо якість для української погана - прапорець off).
3. `feat(core): prerouter + thread-queue` - команди (07 §10: чинні як є, `/new`, підказки R26), DM як `thread_id=dm`, callback-префікси, черга треду, «стоп», тривіальність → `quick`, `ESCALATE`.
4. `feat(core): голос` - Deepgram (+ Whisper резерв), «Я почув» ✅.
5. `feat(docs): persona.md + instructions sync` - `sync-instructions.yml`, `instructions` у D1, хеш-парність тестом (етап 3 додає решту файлів, але механізм - тут).
6. `feat(core): tools запису` - `reminders.*`, `record` (через чинні модулі KV: чек-ін → `updateStats`/`recordEvent`, голос за новину, стадія вакансії, роадмеп), `proposals.create` (calendar.*, contact, settings), `facts`, `chain.start` (заглушка до етапу 5).
7. `feat(core): перемикання` - `ASSISTANT_V2=on`: вебхук іде в новий шлях; новий `GOOGLE_REFRESH_TOKEN` (зі `drive.file`+`tasks`) кладеться в CF; міграція KV `reminders`/`assistantPending` → D1 скриптом з перевіркою кількості; старий `host/` і `agent-*` видаляються окремим PR `chore: remove legacy host` після тижня на `on`.
8. `feat(brain): працівники-заглушки` - `quick` як працівник; `delegate` готовий (файли працівників - етап 4).

Переноситься: логіка дій `agent-core` → інструменти; `proposals.mjs` → `policy`; `callbacks.mjs` → `prerouter`; `tg-core` парсинг (+voice, +business); `assistant-data-core` → `data.read` зі scope.
Не переноситься: `host/*`, `agent-run-core`, `llm-host`, `assistant-memory-core`, `agent-loop-core`.
Ламається/замінюється: `agent-core.test`, `agent-runtime.test`, `llm-host-core.test`, `agent-loop-core.test`, `agent-run-core.test` → тести інструментів, policy, prerouter, brain (мок SDK).
Тести: unit - кожен інструмент (07 §4), маршрутизатор (S-N3-1…6), кожна команда 07 §10, taint-хук, черга треду, undo; contract - Zod ↔ JSON; scenario - S-0-1, S-0-2, S-0-3, S-0-4, S-0-5, S-0-7, S-0-8, S-0-9, S-0-10, S-0-11, S-0-12, S-0-13, S-0-14, S-0-15, S-0-17, S-0-18, S-0-19, S-6-1…5, S-N1-1…4, S-N2-1…3 (S-0-6 - етап 7; S-0-16 - етап 3); smoke - handshake версій.
Приймання (прод, спершу в `shadow` з префіксом `v2:`, потім `on`; чеклист у Telegram):

1. «привіт» → відповідь ≤ 9 с у стилі персони.
2. «скільки 17 % від 4 200» → «714 (4 200 × 0,17)» ≤ 4 с.
3. «що в мене в календарі завтра» → список.
4. «нагадай о 18:00 полити квіти» → «Записав … ↩» → о 18:00 нагадування з snooze.
5. голосове «запиши чек-ін: сон 7 годин» → «Я почув…» ✅ → чек-ін у KV `stats` (перевірка в Mini App).
6. «знайди лист від Нової пошти» → переказ; далі «нагадай завтра забрати» → T1 (tainted) ✅.
7. «створи подію завтра о 10 Стоматолог» → пропозиція ✅ → подія в календарі.
8. два повідомлення поспіль → друге в черзі, обидва відповіді.
9. `/new` → «з чистого аркуша»; «що я казав 5 хв тому» → не памʼятає; `/clear 3` видаляє 3 останні повідомлення як і раніше.
   9a. те саме повідомлення в DM з ботом → та сама відповідь і памʼять (`thread_id=dm`).
10. вимкнути мозок (`systemctl stop`) → «недоступний, спробую за 5 хв»; увімкнути → черга виконалась.
11. міграція: кількість нагадувань у D1 = у KV до міграції; чек-ін у `stats` не змінився (хеш до/після).
    Відкат: `ASSISTANT_V2=off` (старий хост ще на VPS, `systemctl start`); KV не змінювався (крім `reminders` - бекап перед міграцією).

## Етап 3 · Звіт, ідеї, колекції - 3 дні

PR-и: `feat(docs): weekly-review.md v2 + чеклісти + працівники (файли)`; `feat(core): data.read scope=weekly` + `runs.query` (архів, серії, важелі, 7-денні агрегати, кап 50k); `feat(brain): профіль weekly-review` + задача планувальника нд 09:00 + `reports`; `feat(core): ideas + idea_events + команди`; `feat(core): collections/records + компілятор фільтрів`; `feat(core): backup` (нд 03:00 → Drive через `drive.file`, шифрування, відновлення скриптом); `feat(core): daily-hint + memory-summarize` (задачі планувальника, S-0-16, S-N1-4); `feat(core): план дня v2` - модуль `slots` (детермінований, фікстури календаря/чек-іну), таблиці `day_plans`/`plan_items`, `DayPlanChain`, задача `day-plan-kick`, працівник `day-planner` (ADR-035, S-P-8…18) - ≈ 3 дні.
Ламається: назва `tests/weekly-review.test.ts` зайнята - новий `tests/weekly-review-profile.test.ts`.
Тести: unit - scope weekly ≤ 50k, компілятор фільтрів (інʼєкції неможливі), бекап/відновлення round-trip, daily-hint (≤ 1/день, mute), `slots` (заповнення ≤ fill_ratio, жорсткі першими, енергетичні вікна, групування errand, відсутність перетинів з календарем); scenario - S-9-1…5, S-3-1, S-3-2 (план), S-3-6, S-3-7, S-N4-1…5, S-0-16, S-P-8…18.
Приймання: «звіт зараз» → звіт зі всіма блоками і хешем; «збережи ідею…» → «проаналізуй ідею N» (план) → «план у роботу»; «створи колекцію Сервіси…» → «додай…» → «покажи… де …»; бекап у Drive є і відновлюється в локальну D1 (`--local`, `--dry-run`).

## Етап 4 · Аналіз коду і працівники - 3 дні

PR-и: `feat(ci): idea-analysis.yml` (repository_dispatch, checkout 4 репо за PAT, `claude -p` з `code-reviewer.md`, `timeout-minutes: 40`, артефакт або `failed` → ядро); `feat(core): IdeaAnalysis Workflow + /internal/artifact + кеш sha`; `feat(brain): 10 працівників з D1 + delegate` (taint-успадкування, `max_steps` з front-matter, формат виходу, .md + Drive); `feat(core): корпус стилю` (збір повідомлень власника за командою «збери мій стиль» T1 → `style_corpus` у D1 → diff для copywriter.md).
Тести: unit - кеш sha, парсинг артефакту, delegate (мок субагента); scenario - S-3-3…S-3-5, S-3-8, S-7-1…6.
Приймання: «проаналізуй ідею N по коду» → документ ≤ 40 хв; повторно → з кешу; «копірайтер: …» → результат з кнопками; Дослідник → джерела з датами; далі запис → T1.

## Етап 5 · Ланцюги - 4 дні

PR-и: `feat(core): places/routes/geocoding адаптери + quota_counters`; `feat(core): TableChain` (S-1-*); `feat(core): PriceTrack`; `feat(core): TripChain + чеклісти + vehicles`; `feat(core): steam-check (ITAD/Steam) + wishlist import`; `spike(core): Browser Rendering для квитків` (тайм-бокс 1 день; результат - ADR або відмова).
Тести: unit - машина станів кожного Workflow (мок `waitForEvent`), правила нагадувань +5/+20, розрахунок виходу, вартість авто; scenario - S-1-1…15, S-5-1…12.
Приймання: повний ланцюг столика від голосового до «Як було?» у проді (з реальними Places); поїздка з чеклістом і T-7 блоком (дата близька для тесту); гра зі знижкою (узяти гру, що вже зі знижкою).

## Етап 6 · Гроші й чати - 3 дні

PR-и: `feat(core): mono webhook + reconcile + правила + категорії MCC + subscriptions + вечірній рядок`; `feat(core): business connection + inbox + InboxExport + дайджест + forget`.
Тести: unit - правила незвичного, дедуп за id, upsert підписок, парсер експорту Telegram, ретенція; scenario - S-4-1…12, S-2-1…10.
Приймання: тестова покупка (реальна 1 грн-транзакція або `POST /internal/test/mono` з `X-Test: 1`) → повідомлення; вечірній рядок; Business-підключення в Telegram → Business → Chatbots → чинний бот; експорт чату → пошук; «забудь чат» T2.

## Етап 7 · Google-ревізія й завершення - 2 дні

PR-и: `feat(core): окремий OAuth-клієнт ядра (якщо Actions ще потребує свого), Tasks, Sheets-експорт`; `feat(core): mail-triage у ядрі` + `chore(ci): brief.yml без Google-токена`; `feat(core): gemini.image (T1) / gemini.video (T2)` з policy «лише prompt власника» (ADR-034); `docs(ops): runbook секретів + secret-expiry задача`; `feat(core): експорт даних (S-0-6, kind=data.export)`.
Тести: scenario - S-8-1…8, S-0-6; unit - скоупи в токені (фейл при зайвому), ціна в пропозиції.
Приймання: подія з учасником → запрошення прийшло; картинка за $0.04; видалення Google-токена з GitHub Secrets → брифінг наступного ранку прийшов; runbook пройдено (ротація одного ключа, напр. HMAC).

## Після етапу 7 (окремі рішення)

- Mini App: екран колекцій, статус асистента (WebSocket) - окремий план.
- Брифінг → Workflows (ADR-026 перегляд).
- MTProto (ADR-013), Gemini CLI, Photos Picker - за потреби.

## Зведена таблиця

| Етап  | Дні | Залежить | Перша користь                                  |
| ----- | --- | -------- | ---------------------------------------------- |
| 0     | 1   | -        | секрети                                        |
| 1     | 5   | 0        | планувальник замість кронів; Tunnel; прапорець |
| 2     | 8   | 1        | **новий асистент у проді**                     |
| 3     | 6   | 2        | звіт, ідеї, колекції, бекапи, план дня v2      |
| 4     | 3   | 3        | аналіз коду, працівники                        |
| 5     | 4   | 2        | столик, поїздки, Steam, відстеження цін        |
| 6     | 3   | 2        | гроші, чати                                    |
| 7     | 2   | 2, 3     | Google-ревізія, картинки, runbook              |
| Разом | 32  |          | етапи 5-7 можна паралелити після 2             |

## Як вести розробку по сесіях

1. Одна сесія Claude Code = один етап (або один PR, якщо етап великий). На вході - ця тека (`final/`), `plan.md` зі станом, номер етапу.
2. Перед початком етапу - прочитати `03-plan.md` (етап), `07-schema.md`, відповідні рядки `04-scenarios.md`; перелічити PR-и; починати з тестів контрактів.
3. Кожен PR: тести → код → `/code-review` → `/security-review` → PR у `develop` → PR у `main` (за прапорцем `off`) → чеклист у проді (`shadow`/`v2:`) → `on` наприкінці етапу.
4. Закриття етапу: чеклист пройдено → PR `develop` → `main` → smoke → у `plan.md` рядок «Етап N прийнято <дата>» (пише власник або за його словом).
5. Будь-яке відхилення від документа - спершу ADR у `02-decisions.md`, потім код.

## Секрети - інвентар 24.08 і що з ними робити (етап 0/1)

Факт (`wrangler secret list`, `gh secret list`, 24.08): Cloudflare - 19 секретів; GitHub - 17; дублюються в обох: `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHAT_ID`, `TOPIC_ASSISTANT/BRIEFING/SYSTEM`, `MINI_APP_URL`, `WEATHER_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`.

| Дія                                                                                                                              | Що                                                                                                                                                                                                                                                                                                            | Коли                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Лишити як є                                                                                                                      | CF: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GOOGLE_*` (3), `GH_DISPATCH_TOKEN`, `WEATHER_API_KEY`; GH: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CLAUDE_CODE_OAUTH_TOKEN`, `NEWSDATA_API_KEY`, `WEATHER_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`                                                                | -                                               |
| Додати в CF                                                                                                                      | `MAPS_API_KEY`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `ITAD_API_KEY`, `MONO_TOKEN`, `MONO_WEBHOOK_SECRET`, `BRAIN_ACCESS_CLIENT_ID/SECRET`, `INTERNAL_HMAC_KEY`, `BACKUP_ENC_KEY`                                                                                                                             | етап 0 (`stage0/README.md`)                     |
| Додати в GH                                                                                                                      | `REPO_READ_PAT`, `VPS_DEPLOY_KEY`                                                                                                                                                                                                                                                                             | етап 0                                          |
| Додати var (plaintext, не секрет) у Worker                                                                                       | `ASSISTANT_V2=off`                                                                                                                                                                                                                                                                                            | етап 1, PR 1                                    |
| Прибрати з CF (не читаються Worker'ом - VERIFIED grep)                                                                           | `GOOGLE_TRANSLATE_API_KEY`, `TOPIC_ROADMAP`                                                                                                                                                                                                                                                                   | етап 1, після PR 1 (перевірити `/status`)       |
| Прибрати з CF після `on` (етап 2)                                                                                                | `LLM_HOST_SECRET`, `LLM_HOST_URL`, `LLM_HOST_AGENT_URL` (якщо є як var)                                                                                                                                                                                                                                       | етап 2, `chore: remove legacy host`             |
| Прибрати з GH після перенесення тріажу пошти                                                                                     | `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`                                                                                                                                                                                                                                                                       | етап 7                                          |
| Перевести з «секрет» у var (plaintext) - не чутливі, але це лише порядок, не безпека; робити одним PR на `wrangler.jsonc` `vars` | `TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_COOWNER_USER_IDS`, `TOPIC_*`, `MINI_APP_URL`, `GH_REPO`, `PUBLIC_STATUS_ORIGIN`, `REMINDER_INTENT_ROUTING` (а в GH - лишити секретами: Actions не має окремого типу для непублічних змінних, крім `vars`, які видно в логах) | етап 1, необовʼязково                           |
| Зʼясувати (UNKNOWN - `wrangler secret list` не показує plaintext vars)                                                           | чи задані в дашборді `LLM_HOST_AGENT_URL`, `GH_REPO`, `PUBLIC_STATUS_ORIGIN`, `REMINDER_INTENT_ROUTING`, `TELEGRAM_ALLOWED_USER_IDS`; у GH - `OWNER_LOCATIONS` (посилається `brief.yml`, у списку секретів немає - опційний за `config.ts`)                                                                   | етап 0: відкрити Workers → Settings → Variables |
