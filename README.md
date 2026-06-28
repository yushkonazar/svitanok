# Svitanok 🌅

Персональний ранковий брифінг-бот у Telegram. Щоранку о 08:00 (Київ) надсилає
один структурований брифінг: стоїчний рядок, синтез «на сьогодні» (погода по
двох локаціях + календар), розумні новини, картку «крок до офера».

Запуск — у хмарі (**GitHub Actions cron**), без увімкненого ноута. Курація
новин — на **Claude Pro** через `claude -p` (не платний API).

> 📜 Повна специфікація, архітектура й конвенції розробки — у [SPEC.md](SPEC.md).
> Окремого `CLAUDE.md` у проєкті немає: усі конвенції живуть у SPEC.md (§11, §17).

## Стек

- Node.js + TypeScript (ESM, strict), запуск через `tsx`
- Планувальник: GitHub Actions cron (UTC; 08:00 Київ = 05:00/06:00 UTC)
- Тести: **vitest**; лінт: ESLint + Prettier; пін Node — `.nvmrc`

## Скрипти

| Команда                                 | Опис                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck`                     | `tsc --noEmit`                                                      |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                   |
| `npm test`                              | vitest                                                              |
| `npm run dry-run`                       | прогін оркестратора без запису стану (рахує, не шле поза `--force`) |
| `node scripts/check-telegram.mjs`       | діагностика бота + пошук `chat_id` (§6)                             |
| `node scripts/guard.mjs [--force]`      | CI-гейт відправки (єдине джерело, §19.1)                            |

## Налаштування

1. Скопіюй `.env.example` → `.env`, заповни секрети (ті самі — у GitHub Secrets).
2. Знайди `chat_id`: `node scripts/check-telegram.mjs`.
3. Деталі підготовки — SPEC.md §0, §12.

## Розробка

git-flow: `main` ← `develop` ← `feature/*`, окрема `test` для CI-прогонів,
`state` — лише для машинних комітів стану бота. Покрокові коміти
(Conventional Commits). Деталі — SPEC.md §17.
