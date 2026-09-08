# 01 · Архітектура (варіант В)

Канонічні імена - у `07-schema.md`. Мітки: VERIFIED / INFERRED / UNKNOWN.

## 1. Контекст

```
 власник (iOS, десктоп)
   │ текст · голос · кнопки · Business-чати · Mini App
   ▼
 Telegram Bot API 10.2 ──вебхук──▶ ЯДРО (Cloudflare, Paid) ──Tunnel──▶ МОЗОК (VPS CX23, Agent SDK, Max)
   ▲                                │  D1 · KV · Scheduler DO · RunRegistry DO · Workflows · Vectorize · AI Gateway
   └──────send/edit/document────────┤
                                    ├──▶ Google (Calendar, Gmail ro, Drive, Contacts, Tasks; Places, Routes, Geocoding; Gemini Tier 1)
                                    ├──▶ Monobank (вебхук → ядро; виписка), Deepgram, IsThereAnyDeal/Steam, OpenWeather, NewsData
                                    └──▶ GitHub Actions (brief · idea-analysis · deploy-host · sync-instructions)
```

## 2. Компоненти

### 2.1 Ядро - Cloudflare Worker (Paid $5/міс)

| Модуль (`web/core/…`) | Відповідальність                                                                                                                                                                                                                                                                          | Важливі правила                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gateway`             | вебхук Telegram: секрет, allowlist власника, парсинг `message` (text/voice/location/document), `callback_query`, `business_message`, `business_connection`; DM з ботом і тема «Асистент» - обидва входи (`thread_id = dm` або id теми); відповідь 200 ≤ 50 мс; `ctx.waitUntil` для роботи | усе не від власника - 200 і тиша; Business-повідомлення → `inbox_messages` без LLM |
| `prerouter`           | команди (таблиця 07 §10: чинні лишаються, `/new` і підказки R26 нові), callback-и (`p:`, `c:`, `r:`, `a:`, `u:`, `m:`), відповіді на `ask`, голос → Deepgram → «Я почув» (T0), тривіальність → профіль `quick`, інакше `chat`                                                             | детермінований; список правил у `04-scenarios.md` §N3                              |
| `thread-queue`        | один активний прогін на тред; друге повідомлення чекає в `outbox`-черзі треду і йде в ту саму сесію; «стоп» перериває                                                                                                                                                                     | рішення Q4                                                                         |
| `policy`              | рівень дії (T0/T1/T2) за таблицею + taint-біт; створює `proposals`; виконує лише після ✅/слова; undo для T0 10 хв                                                                                                                                                                        | єдине місце, що викликає адаптери запису                                           |
| `tools`               | реалізація `/internal/tool/*` (07 §4): читання + маркування зовнішнього вмісту `<external source="…">`                                                                                                                                                                                    | кожен інструмент - окремий файл з unit-тестом                                      |
| `adapters`            | Google (OAuth refresh, Calendar/Gmail/Drive/People/Tasks), Maps (Places/Routes/Geocoding + `quota_counters`), Gemini, Monobank, Deepgram, ITAD/Steam, OpenWeather, NewsData                                                                                                               | ключі лише тут; помилка адаптера = явна помилка інструмента                        |
| `tg`                  | `outbox` з троттлінгом 1/с на чат, 20/хв; Rich Messages (draft-стрімінг), fallback на звичайні; документи ≤ 50 MB                                                                                                                                                                         | усі відправки через outbox - нічого не губиться при 429                            |
| `scheduler` (DO)      | таблиця `jobs`, один alarm, ідемпотентність за `dedupe_key`, виконавці задач (07 §7)                                                                                                                                                                                                      | точність alarm заміряється на етапі 1 (UNKNOWN)                                    |
| `run-registry` (DO)   | слоти (≤ 2), `runs` телеметрія, сторож обірваних (> 6 хв), handshake мозку                                                                                                                                                                                                                |                                                                                    |
| `workflows`           | 5 Workflows (07 §6)                                                                                                                                                                                                                                                                       | події лише через `/internal/chain/event`                                           |
| `memory`              | `facts`, `sessions.summary_md`, `memory_chunks` + Vectorize (ембединги Workers AI `bge-m3`, UNKNOWN якість для української - перевірка на етапі 2)                                                                                                                                        | згортка щодня 04:00 для тредів з активністю                                        |
| `api-dashboard`       | Mini App - без змін                                                                                                                                                                                                                                                                       |                                                                                    |
| `instructions`        | завантажувач `instructions` з D1 з перевіркою хешу; нема/розійшлось → помилка                                                                                                                                                                                                             |                                                                                    |

### 2.2 Мозок - `brain/` на VPS CX23 (TypeScript, systemd, окремий користувач)

- HTTP лише на `127.0.0.1:8788`; назовні - `cloudflared` Tunnel. Ендпоїнти: `POST /run`, `GET /health`.
- На `/run`: перевірка Access JWT + HMAC; профіль з тіла; `query()` Agent SDK з:
  - `systemPrompt`: персона (з D1 `instructions`, хеш перевірено) + дата/час Київ + локація (`geo.last`) + `facts` (компактно, ≤ 3 000 симв.) + згортка треду;
  - `resume: sessions.sdk_session_id` для профілю `chat`; нові сесії для інших профілів;
  - `mcpServers`: in-process сервер `svitanok` з інструментами 07 §4 (кожен = HTTPS-виклик `/internal/tool/:name`);
  - `allowedTools`: лише `mcp__svitanok__*` (+ `WebSearch`, `WebFetch` лише в субагента `researcher` і профілі `price-check`; + `Read/Grep/Glob` лише в Actions);
  - `agents`: 10 працівників з `instructions` (D1): `description` = перший абзац «Мети», `prompt` = тіло файлу, `tools`/`model`/`maxTurns` = `max_steps` з front-matter (07 §5);
  - `hooks`: `PreToolUse` (taint → відмова прямих записів; заборона неописаних інструментів), `PostToolUse` (крок у `run_steps`), `Stop` (фінал → `/internal/deliver`), `SubagentStop` (taint-успадкування);
  - `model`: `claude-sonnet-5` для `chat`/`weekly-review`/працівників-sonnet; `claude-haiku-4-5` для `quick`/`chain-step`/працівників-haiku;
  - `maxTurns` за профілем; `abortController` на 4/6 хв;
  - стрімінг `includePartialMessages` → `/internal/status` (ядро троттлить до 1/с).
- Авторизація: `CLAUDE_CODE_OAUTH_TOKEN` (setup-token, 1 рік - VERIFIED) у `.env` 600; `--bare` не використовується (не читає OAuth - VERIFIED).
- Без ключів Google/Mono/Gemini/Telegram. На VPS лише три секрети: Claude OAuth, Access service token, `INTERNAL_HMAC_KEY`. Без Bash/Write/Edit.
- `health` віддає канонічний JSON з 07 §3 (`version`, `gitSha`, `sdkVersion`, `claudeVersion`, `limits`, `uptime`); ядро порівнює `version` і `gitSha` з очікуваними після деплою - розсинхрон = алерт (закриває сліпоту чинного health-check).

### 2.3 Сторонні

| Сервіс                                                                                                                               | Навіщо                            | Квота/ціна (VERIFIED)                            | Де ключ                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Google Workspace API (Calendar rw, Gmail ro, Drive ro + `drive.file`, People, Tasks)                                                 | база, кейси 1, 8                  | безкоштовно в квотах                             | CF Secrets (OAuth client + refresh token ядра)                                            |
| Google Maps Platform (Places Text Search Pro 5 000/міс, Place Details Enterprise 1 000/міс, Routes 10 000/міс, Geocoding 10 000/міс) | кейси 1, 4, 5                     | $0 у квотах; понад - з кредиту GDP $10           | CF Secrets (API key, обмежений 3 API + HTTP referrer/IP не застосовні - обмеження за API) |
| Gemini API Tier 1 (Flash Image, Veo 3.1, Flash-Lite)                                                                                 | кейс 8i, дешева мультимодальність | зображення $0.039-0.067; Veo $0.40/с (лише з ✅) | CF Secrets                                                                                |
| Monobank personal API                                                                                                                | кейс 4                            | $0; вебхук + виписка 1/60 с                      | CF Secrets (X-Token)                                                                      |
| Deepgram nova-3                                                                                                                      | кейс 6                            | $0.0043/хв, кредит $200                          | CF Secrets                                                                                |
| IsThereAnyDeal + Steam appdetails                                                                                                    | кейс 5                            | $0                                               | CF Secrets (ITAD key)                                                                     |
| Telegram Business-підключення                                                                                                        | кейс 2                            | $0 (Premium є)                                   | бот той самий                                                                             |
| OpenWeather, NewsData                                                                                                                | як зараз                          | як зараз                                         | як зараз                                                                                  |
| GitHub (Actions 2 000 хв/міс, PAT read-only на 4 репо)                                                                               | кейс 3, деплой                    | $0                                               | GitHub Secrets                                                                            |

## 3. Потоки

### 3.1 Повідомлення (профіль `chat`)

1. Telegram → `gateway`: 200 за ≤ 50 мс; `ctx.waitUntil`.
2. `prerouter`: не команда/callback/тривіальне → `chat`. `thread-queue`: якщо прогін у треді активний - у чергу.
3. `run-registry`: слот; `runs` insert; статус-повідомлення «▸ …» (Rich draft).
4. `POST /run` мозку через Tunnel (202).
5. Мозок: `resume` сесії; системний промпт; `query()`; інструменти → `/internal/tool/*` (ядро маркує зовнішнє, веде taint у `sessions.tainted`); стрімінг → `/internal/status`.
6. Фінал → `/internal/deliver` → `tg` (Rich message + кнопки) → `runs` update → слот вільний → наступне з черги треду.
7. Таймінги (INFERRED): 5-9 с; перший токен 2-4 с.

### 3.2 Швидка смуга (`quick`)

`prerouter` → ознаки тривіальності (≤ 120 симв.; немає згадок «мій/моя/календар/пошта/нагадай/запиши/знайди в…»; є число/оператор або питальне слово факту) → `/run` з профілем `quick` → Haiku, 1 хід, без інструментів → відповідь або `ESCALATE:` → ядро перезапускає `chat` з тим самим текстом (статус «думаю довше»).

### 3.3 Голос

`voice` → `getFile` (≤ 20 MB) → Deepgram (`language=uk`, `model=nova-3`) → транскрипт → повідомлення «Я почув: «…»» з кнопками ✅ / ✏️ → ✅ → далі як текст. Аудіо не зберігається. Deepgram недоступний → Workers AI Whisper з позначкою «резервний розпізнавач» (ogg/opus - перевірка на етапі 2, UNKNOWN).

### 3.4 Кнопки

`callback_query` → `prerouter` за префіксом: `p:` → `policy` (approve/reject/T2 очікує слово), `c:` → `/internal/chain/event`, `r:` → нагадування (snooze/done), `a:` → відповідь на `ask` (resume сесії), `u:` → undo T0, `m:` → меню. Завжди `answerCallbackQuery` ≤ 1 с.

### 3.5 Business-повідомлення (кейс 2)

`business_message` → `inbox_messages` (tainted=1), без LLM. Ретенція 30 днів (`retention-cleanup`). Запит «знайди в чаті X …» → `inbox.search` → модель (tainted). Дайджест 08:30 - якщо увімкнено в `facts.setting.inbox_digest`.

### 3.6 Monobank

`POST /webhook/mono` → 200 одразу → `transactions` insert → правила `merchant_rules` + MCC → `flags_json` → якщо незвичне → повідомлення з кнопками («Перевірити ціни» → профіль `chat` з делегуванням Досліднику; «Категорія» → T0). `mono-reconcile` 23:30: виписка за добу, доставка пропущених; вебхук перевіряється `client-info` і ставиться знову.

### 3.7 Планувальник

Alarm → тік → прострочені задачі послідовно → кожна ідемпотентна за `dedupe_key` (`kind:YYYY-MM-DD[:slot]`) → `last_status`; помилка задачі не зупиняє інші (як чинний `runCronTasks`); `brain-health` кожні 5 хв; `run-watchdog` закриває прогони > 6 хв з повідомленням власнику.

### 3.8 Ланцюги

`chain.start` → `chains` + Workflow instance. Кроки детерміновані (07 §6); кнопки → `/internal/chain/event` → `waitForEvent`. Формулювання (якщо треба) - профіль `chain-step` (Haiku). Пропозиції - через `policy` як і з чату.

### 3.9 Аналіз коду

`ideas.analyze(id)` → Workflow `IdeaAnalysis` → `repository_dispatch` (`GH_DISPATCH_TOKEN`, є) → `idea-analysis.yml`: checkout цільового репо (PAT), `claude -p` з `agents/code-reviewer.md` як системним промптом, `--allowedTools Read,Grep,Glob`, OAuth-токен → результат → `POST /internal/artifact` → `ideas.analysis_md`, документ у тему, копія в Drive. Кеш: якщо `head_sha` не змінився - відповідь з D1 без прогону.

### 3.10 Інструкції

Коміт у `docs/assistant/**` → `sync-instructions.yml` → для кожного файлу: перевірка front-matter, `max_chars`, хеш → `PUT` у D1 `instructions` через Cloudflare API (`CF_API_TOKEN`, як `brief.yml`) → запис в `instruction_history`. Тест парності в CI: хеш у репо (`main`) = хеш у D1.

## 4. Безпека

### 4.1 Зони (коротко; повністю - `05-ops.md` §2)

Z0 власник → Z1 інструкції (репо) → Z2 зовнішній вміст (дані) → Z3 записи назовні (лише ядро, ✅) → Z4 секрети → Z5 VPS → Z6 Google.

Google-акаунт власника: безпеку посилено власником 23.08.2026 (R15, питання закрите). Обмеження для системи: Advanced Protection Program несумісний з неверифікованим OAuth-застосунком (блокує Gmail/Drive) - не вмикати; Security Checkup раз на квартал - нагадування через `daily-hint`.

### 4.2 Taint

- Джерела taint: `mail.*`, `drive.search`, `inbox.search`, `places.*`, результати працівників з `tainted_output: true` (`researcher`, `planner`, `mail-secretary`), будь-який документ від власника, завантажений для аналізу (експорт чату, чек).
- Механізм: ядро повертає результат, обгорнутий `<external source="mail" id="…">…</external>` + ставить `sessions.tainted` = epoch-ms читання; taint діє `TAINT_TTL_MS` = 10 хв після ОСТАННЬОГО зовнішнього читання або до `/new` (рішення власника 05.09.2026 на прийманні етапу 3 - «до /clear або 24 год тиші» робило кожен запис у треді пропозицією на весь день; 30 хв теж названо задовгими); `plan.draft` і `plan.review` БЕЗ carry taint не ескалює (`isTaintExempt` - читання/перерахунок власного плану без зовнішнього ефекту; `plan.review` з carry переносить пункти і лишається під ✅); мозок у `PreToolUse` читає прапорець з відповіді інструмента і блокує T0-записи в тому ж прогоні → модель мусить іти через `proposals` (T1).
- Подвійний барʼєр: навіть якщо хук обійдено, `policy` у ядрі перевіряє `sessions.tainted` і не виконує T0-запис без пропозиції.
- Працівникам передається лише `task` + формат - ніколи транскрипт.

### 4.3 Рівні підтвердження (визначає ядро)

| Рівень | Дії                                                                                                                                                           | Поведінка                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| T0     | `facts.set(owner)`, `reminders.*` (собі), `record`, `ideas/wishes/collections/records` create/update, `chain.start`, `facts.set(inferred)`                    | виконати; повідомлення «Записав: …» + кнопка «↩» 10 хв (`u:`) |
| T1     | `proposals`: calendar.*, invite, drive.write, settings, contact, видалення одного запису, `collection.export`, усе T0 у tainted-сесії                         | одне ✅/❌, TTL 30 хв                                         |
| T2     | forget (чат/колекція/усе), відключення інтеграції, зміна інструкції (лише через репо - тому фактично заборонено з чату), платна дія (gemini.video, понад кап) | ✅ + слово, TTL 10 хв                                         |

### 4.4 Загрози й контрзаходи

| Загроза                              | Контрзахід                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt injection з листа/сайту/чату  | маркування + taint + подвійний барʼєр + працівники без транскрипту + інструкції лише з репо                                                                                                                                          |
| Витік секрету з VPS                  | на VPS лише Claude OAuth + Access creds + HMAC; без ключів Google/Mono/TG; `.env` 600; окремий користувач; systemd hardening; без відкритих портів                                                                                   |
| Витік чутливих даних у сторонній LLM | таблиця «дані → провайдери» (ADR-034): Gemini отримує лише `prompt` власника - policy відкидає `gemini.*` з id транзакцій/чатів/листів; Deepgram - лише аудіо; free tier Gemini заборонений у коді (окремий ключ проєкту з білінгом) |
| Чужий пише боту                      | allowlist на вебхуку; business-повідомлення приймаються лише з `business_connection.user.id == власник`                                                                                                                              |
| Підробка виклику internal API        | Access service token + HMAC + `run_id` з реєстру + TTL 10 хв                                                                                                                                                                         |
| Підробка вебхука Mono                | окремий шлях з секретом у URL (Mono не підписує) + перевірка `account` з `client-info` + звірка виписки                                                                                                                              |
| Тиха поломка хоста                   | handshake версій; сторож прогонів; `runs.error` → алерт                                                                                                                                                                              |
| Зміна політики підписки              | `usage-limit`/403 → алерт + чесна відповідь; план Б в ADR-002                                                                                                                                                                        |
| Втрата даних                         | D1 Time Travel 30 днів + щотижневий зашифрований дамп у Drive назавжди                                                                                                                                                               |
| Перевитрата                          | `quota_counters` + алерти 80 % + платні дії лише T2                                                                                                                                                                                  |

## 5. Середовище і прапорець запуску

Одне середовище - prod (рішення власника 24.08, ADR-009). Замість staging - прапорець `ASSISTANT_V2` (plaintext var Worker):

| Значення                    | Ядро v2                                                                                                                                | Мозок v2 (VPS, :8788, Tunnel)                            | Старий агент/хост                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `off` (типово після деплою) | код є, не викликається; міграції D1 застосовані, таблиці порожні                                                                       | працює, приймає лише `/health` і ручні `/run` з підписом | працює як зараз                                                            |
| `shadow`                    | планувальник тікає паралельно з `CRON_TASKS` у режимі «лише лог»; prerouter класифікує повідомлення і пише в `runs`, але не відповідає | те саме                                                  | працює                                                                     |
| `on`                        | вебхук → новий шлях; планувальник замість кронів; старий хост більше не викликається                                                   | бойовий                                                  | вимкнений (`systemctl stop svitanok-llm-host`), код видаляється на етапі 2 |

Один набір секретів; Mono-вебхук і Business-підключення - лише після `on`. Резерв - тег `pre-redesign` і прапорець назад на `off`. Тестові транзакції Mono - `POST /internal/test/mono` (за Access, лише коли `ASSISTANT_V2 != on` або з явним `X-Test: 1` від власника).

## 6. Спостережуваність

- `runs`/`run_steps` у D1 (90 днів) - головне джерело «чому він так відповів».
- Workers Logs (Paid, 7 днів), журнал `svitanok-brain` у journald (30 днів), AI Gateway без тіл промптів (Gemini/Workers AI).
- Алерти в `TOPIC_SYSTEM`: збої, розсинхрон версій, `invalid_grant`, Mono вебхук, квоти 80 %, кредити, терміни токенів. Критичне (мозок > 10 хв, токен Google) - дубль у тему «Асистент».
- Блок «СИСТЕМА» у тижневому звіті.

## 7. Квоти й бюджет (на місяць)

| Ресурс                                 | Очікуване використання (INFERRED)                      | Ліміт                  | Алерт                     |
| -------------------------------------- | ------------------------------------------------------ | ---------------------- | ------------------------- |
| Claude Max                             | ~250 прогонів `chat`, 100 `quick`, 4 звіти, працівники | спільно з інтерактивом | `usage-limit` у відповіді |
| Places Text Search                     | 20-60                                                  | 5 000                  | 80 %                      |
| Place Details Enterprise               | 10-30                                                  | 1 000                  | 80 %                      |
| Routes                                 | 30-100                                                 | 10 000                 | 80 %                      |
| Gemini (зображення)                    | 0-50 зобр. ≈ $0-3                                      | кредит $10             | < $2                      |
| Deepgram                               | 10-60 хв ≈ $0.04-0.26                                  | кредит $200            | < 10 %                    |
| Workers AI (ембединги, резерв Whisper) | ≤ 2 000 нейронів/добу                                  | 10 000/добу            | 80 %                      |
| D1                                     | < 10k записів/добу                                     | Paid 50M/міс           | -                         |
| Workflows                              | < 200 кроків/добу                                      | Paid 500k/міс          | -                         |
| GitHub Actions                         | 162 + 20-60 хв                                         | 2 000                  | > 1 500                   |
| **Гроші**                              | **$5** (Paid)                                          | стеля $15              | -                         |
