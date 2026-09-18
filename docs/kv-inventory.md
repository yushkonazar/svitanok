# Інвентаризація KV і control planes

Статус: переглянуто 2026-09-18. Це повний реєстр production-використань
`env.BRIEFING` (включно з динамічними префіксами), а не лише ключів, що містять
персональні дані. Він є критерієм для інваріанту «KV не є конкурентним mutable
source of truth» у `modernization-plan.md`.

## Canonical Durable Objects, KV лише mirror або rollback seed

| Дані                                | Canonical control plane | KV compatibility key         |
| ----------------------------------- | ----------------------- | ---------------------------- |
| user state, stats, settings         | `StateStoreDO`          | `state`, `stats`, `settings` |
| active agent runs                   | `RunRegistryDO`         | `agentRuns`                  |
| T1 assistant proposal               | `PendingProposalsDO`    | `assistantPending`           |
| `/clear` delivery ids               | `SentMessagesDO`        | `sentMessages`               |
| short assistant context             | `AssistantHistoryDO`    | `assistantHistory`           |
| one-shot continuation               | `AssistantResumeDO`     | `assistantResume:*`          |
| briefing workflow dispatch          | `BriefDispatchDO`       | `briefDispatch`              |
| live OpenWeather budget             | `WeatherQuotaDO`        | `weatherLiveCounter`         |
| daily Business inbox admission      | `InboxQuotaDO`          | `inboxDayCount`              |
| VPS health transition / owner alert | `AgentHostHealthDO`     | `agentHostHealth`            |
| multi-tick Mono reconciliation      | `MonoReconcileDO`       | `monoReconcile`              |
| weekly encrypted backup             | `BackupStateDO`         | `backupState`                |
| weekly brain-review delivery        | `WeeklyReviewStateDO`   | `weeklyReviewState`          |

Кожен рядок вище має одноразовий legacy seed і canonical read за наявного
binding. Для зовнішньої дії canonical binding або fail-closed (погода,
dispatch, health alert), або зберігає попередню гарантію не втрачати дані
(Business inbox).

## Допустимий KV: snapshot, cache, конфігурація або immutable receipt

| Ключ / префікс                                              | Роль                                      | Чому не потребує RMW control plane                                             |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `saved`, `latest`                                           | останній immutable briefing snapshot      | новіший цілісний snapshot замінює старий                                       |
| `statsArchive`, `statsArchiveWeekly`, `levers`              | derived analytics cache                   | обчислюється детерміновано з canonical state/D1                                |
| `weatherLive`, `calendarToday`, `mailTriage`, `googleToken` | TTL cache зовнішнього read                | stale cache деградує read, не створює дію                                      |
| `publicStatus`, `brainExpected`, `brainHealthState`         | status/release projection                 | display/config projection, не owner transition                                 |
| `ownerGeo`, `ownerGeoManual`                                | latest owner location / explicit override | last-write-wins configuration, без field-level RMW                             |
| `dataDeletionReceipt`, `dataDeletionReceipt:*`              | immutable T2 receipt і bounded history    | кожна історична квитанція має власний ключ; current receipt лише resume marker |
| `executed:*`                                                | TTL idempotency tombstone                 | create-once marker без JSON merge                                              |
| `secret_rotated_*`, `secret_expiry_*`, `security_hint_at`   | operational audit marker                  | одноразовий timestamp/flag, не domain record                                   |

## Scheduler markers

`dayPlanKickDay`, `memorySummarizedDay`, `subscriptionRemindDay`,
`financeEveningDay`, `inboxDigestDay`, `retentionCleanupDay`,
`secretExpiryDay`, `quotaCheckDay`, `priceTrackKickDay`, `dailyHintDay` і
`steamCheckDay` — це write-once значення поточної дати. Вони не несуть
нарощуваного payload; дубльований тік додатково зупиняється D1 unique key,
workflow id або downstream idempotency. Їх не слід перетворювати на
загальний JSON state-store лише заради самого факту запису.

## Залишкові scheduler-only state machines

Ці ключі не містять owner content і сьогодні мають один планувальний writer,
але це саме structured progression, а не cache. Вони лишаються відкритими
пунктами 1B до переходу на D1 event rows або окремий lease-based DO:

| Ключ                                 | Поточна функція                                | Умова завершення міграції                                                  |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `steamCheckMisses`, `steamSaleShare` | anomaly streak та derived Steam price state    | або scheduler DO, або D1 event/projection після одночасного Steam workload |
| `monoUnknownAlert`                   | one-alert throttle для невідомого Mono account | atomic rate gate, якщо webhook може паралелитися                           |

`INBOX_COUNT_KEY`/`WEATHER_LIVE_COUNTER_KEY` більше не належать цій групі:
їхні concurrency tests перевіряють точне резервування. `agentHostHealth` також
вже canonical у DO, щоб паралельні probes не створювали два owner alerts.

## Retention

`FORGET_ALL_KV_KEYS` містить усі owner-data keys та compatibility mirrors,
потрібні T2. Service keys (`backupState`, `monoReconcile`, scheduler markers)
навмисно не видаляються: їхнє стирання могло б спричинити дубльований backup
або повторний 31-day Mono import. Точні докази і порядок T2 описані в
`data-retention.md`.
