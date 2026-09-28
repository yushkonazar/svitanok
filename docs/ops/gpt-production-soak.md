# GPT production soak

Цей runbook підтверджує стабільність production-переходу на GPT до cleanup
legacy Claude path. Це **лише читання**: не змінює Worker, D1, Git, секрети,
Telegram або дані власника.

## Межа й правило рішення

- Базова Worker-версія telemetry: `2026-09-26T23:24:32Z`.
- Перевірка триває сім повних діб від базової версії.
- У вибірку входять тільки model/workflow runs: `profile IS NOT NULL`.
- Негайний incident: хоча б один scheduler-run без profile після бази; будь-який
  model step `claude:*`; нездоровий deployment або CI; за добу є 10+ model
  runs і failure rate >=5%.
- Нормальний день не потребує повідомлення в Telegram. На сьомий день - короткий
  висновок із кількістю GPT runs, моделями, failure rate та latency.
- Лише після семи чистих діб, rollback-tag і успішного restore drill можна
  планувати окремий PR cleanup. Не видаляти legacy-шлях під час soak.

## Агрегати D1

Підстав у `FROM` лише безпечний часовий фільтр. Ці запити навмисно не
повертають `thread_id`, input, output, prompt, note або аргументи інструментів.

```sql
-- Денний обсяг і failure rate model/workflow runs.
SELECT
  COUNT(*) AS model_runs,
  SUM(CASE WHEN error IS NOT NULL AND TRIM(error) <> '' THEN 1 ELSE 0 END) AS failed_runs,
  ROUND(
    100.0 * SUM(CASE WHEN error IS NOT NULL AND TRIM(error) <> '' THEN 1 ELSE 0 END)
      / NULLIF(COUNT(*), 0),
    2
  ) AS failure_rate_pct
FROM runs
WHERE profile IS NOT NULL
  AND started_at >= :from_iso
  AND started_at < :to_iso;

-- Моделі без жодних даних діалогу.
SELECT
  COALESCE(NULLIF(model, ''), 'unknown') AS model,
  COUNT(*) AS runs,
  SUM(CASE WHEN error IS NOT NULL AND TRIM(error) <> '' THEN 1 ELSE 0 END) AS failed
FROM runs
WHERE profile IS NOT NULL
  AND started_at >= :from_iso
  AND started_at < :to_iso
GROUP BY COALESCE(NULLIF(model, ''), 'unknown')
ORDER BY runs DESC;

-- Latency allowlisted model metadata. `run_steps.note` не читаємо.
SELECT
  name AS model,
  COUNT(*) AS calls,
  ROUND(AVG(ms), 0) AS avg_ms,
  MAX(ms) AS max_ms,
  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_calls
FROM run_steps
WHERE kind = 'model'
  AND name LIKE 'openai:%'
  AND at >= :from_iso
  AND at < :to_iso
GROUP BY name
ORDER BY calls DESC;

-- Обидва нульові результати є інваріантами rollout.
SELECT COUNT(*) AS unprofiled_scheduler_rows
FROM runs
WHERE trigger = 'scheduler'
  AND profile IS NULL
  AND started_at >= '2026-09-26T23:24:32Z';

SELECT COUNT(*) AS claude_model_steps
FROM run_steps
WHERE kind = 'model'
  AND name LIKE 'claude:%'
  AND at >= '2026-09-26T23:24:32Z';
```

Запусти їх у Cloudflare D1 console або через `wrangler d1 execute` з remote
target. Не вставляй результати з рядковими полями в чат або в issue: для soak
потрібні лише числа й назви моделей.

## Deployment і CI

Перевір тільки `main`:

```sh
git fetch origin main
git rev-parse origin/main
gh run list --branch main --limit 10 --json status,conclusion,workflowName,headSha,createdAt
npx wrangler deployments list
```

Очікування: останній healthy Worker deployment відповідає main, а останні
обов'язкові workflow завершені `success`. `queued`/`in_progress` не є успіхом;
повтори перевірку після завершення, не змінюючи deployment.

## Формат підсумку на сьомий день

```text
GPT soak, 7/7 днів: <N> model/workflow runs.
Моделі: <model: count, ...>.
Failure rate: <X%>; model latency: <avg/max за моделлю>.
Інваріанти: scheduler без profile = 0; Claude model steps = 0; CI/deployment = healthy.
Висновок: cleanup legacy Claude path можна / не можна планувати окремим PR.
```
