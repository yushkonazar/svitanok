# Файли-інструкції асистента

Це те, що читає модель. Джерело - ці файли в git; у D1 `instructions` вони потрапляють лише через `sync-instructions.yml` з хешем (ADR-016). Чат інструкцій не пише - він може щонайбільше підготувати diff, який власник комітить сам.

Правки перевіряє `tests/instructions.test.ts` (той самий валідатор, що й синк), тож зламану інструкцію видно на PR, а не в проді.

⚠️ Ці файли виключені з prettier (`.prettierignore`): вони не код, а текст для моделі - автоформатування розпухає промпт і змінює `sha256` тіла, тобто хеш у D1 розійшовся б із файлом сам собою.

| Файл | kind | Хто читає | Коли |
|---|---|---|---|
| `persona.md` | persona | профіль `chat` (системний промпт) | кожен прогін чату |
| `agents/researcher.md` | agent | субагент Дослідник; профіль `price-check` | `delegate`, PriceTrack |
| `agents/analyst.md` | agent | Аналітик | `delegate` |
| `agents/planner.md` | agent | Планувальник | `delegate` |
| `agents/copywriter.md` | agent | Копірайтер (розділ «Стиль власника» заповнюється після збору корпусу, етап 4) | `delegate` |
| `agents/editor.md` | agent | Редактор | `delegate` |
| `agents/quick.md` | agent | профіль `quick` (швидка смуга) | маршрутизатор |
| `agents/code-reviewer.md` | agent | профіль `idea-analysis` у GitHub Actions | `ideas.analyze(mode=code)` |
| `agents/finance.md` | agent | Фінансист (лише `question`/`explain`; правила рахує ядро) | `delegate` |
| `agents/mail-secretary.md` | agent | Секретар-пошта (tainted) | `delegate` |
| `agents/tutor.md` | agent | Навчальний | `delegate` |
| `agents/day-planner.md` | agent | Денний (намір → пункти, уточнення, пояснення; розкладка - ядро) | `DayPlanChain`, `/plan`, `delegate` |
| `checklists/ua-car.md`, `abroad-plane-bus.md`, `ua-train-bus.md` | checklist | `TripChain` (текст блоків T-30/T-7/T-1) і Планувальник | створення поїздки |
| `weekly-review.md` | profile | профіль `weekly-review` | нд 09:00 / «звіт зараз» |

## Front-matter (обовʼязковий)

```yaml
---
name: researcher            # = імʼя файлу без .md; ключ у D1 instructions
kind: agent                 # persona | agent | checklist | profile
model: sonnet               # haiku | sonnet | -  (для checklist «-»)
tools: [WebSearch, WebFetch] # ⊂ 07-schema §4 або WebSearch/WebFetch/Read/Grep/Glob
tainted_output: true        # вихід = зовнішній вміст → сесія tainted
updated: 2026-08-23
max_chars: 7000             # стеля довжини; перевищення = помилка збірки
max_steps: 30               # лише agent: maxTurns/ліміт викликів інструментів (типово 6)
---
```

`description` для `AgentDefinition` SDK = перший абзац розділу «Мета»; `prompt` = тіло файлу.

## Тести (CI, етап 2-4)

1. Front-matter повний; `name` = імʼя файлу; `kind` з переліку.
2. `len(тіло) < max_chars` (символи, не байти) - міряється ТІЛО без front-matter: у промпт їде саме воно, а службові поля стелі не витрачають.
3. `tools` ⊂ канонічного переліку 07 §4 ∪ {WebSearch, WebFetch, Read, Grep, Glob}; для `kind: persona` - порожній (інструменти задає профіль). Звірка з каноном, а не з живим реєстром інструментів ядра: інструкції описують кінцевий стан, і половина інструментів приїде на етапах 3-7 - друкарську помилку канон ловить так само.
4. Хеш у D1 (`instructions.version_hash`) = `sha256(тіло)` файлу в `main`, з нормалізованими переносами. Хешується тіло, а не файл, щоб звірка мала сенс і в рантаймі: ядро перевіряє цілісність того, що справді йде в промпт.
5. Жодного тире (—, –), лише дефіс. Заборона згадок постачальників моделей автоматично НЕ перевіряється: вона про тон персони («я - Світанок», а не назва постачальника), а буквальний пошук слів дає хибні спрацювання на назвах лічильників (`gemini_usd` у звіті) і зовнішніх інструментів (сесія Claude Code в Actions) - обидва легітимні.
6. Обовʼязкові розділи за `kind` присутні (persona: 7; agent: 7; checklist: 8; profile: §0-§6).

## Правки

Правка = коміт у `docs/assistant/**` → CI → D1. Інструкція старша за 6 місяців (`updated`) - рядок у блоці «СИСТЕМА» тижневого звіту. Чат може лише підготувати diff («запропонуй правку інструкції X»), який власник комітить сам.
