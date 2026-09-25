# Workers runtime integration tests

`npm run test:workers` запускає окремий набір тестів у локальному workerd через
Miniflare. Він читає `web/wrangler.jsonc`, отже перевіряє той самий набір
binding-ів, Durable Objects, Workflows та assets, який піде у Worker.

`remoteBindings: false` у `vitest.workers.config.ts` є обов'язковим інваріантом:
тести не можуть читати або змінювати production D1, KV, Workers AI чи Vectorize.
Повідомлення Miniflare про відсутність локальних емуляторів AI/Vectorize не є
підключенням до remote-ресурсів; ці binding-и в цьому наборі не викликаються.

Покриті production-контури:

- D1 migrations, KV, StateStoreDO CAS, SchedulerDO alarm, asset serving і
  `scheduled(...).waitUntil`;
- завершуваний DayPlan Workflow із контрольованими sleep/event кроками;
- Telegram webhook, Mono webhook і Google OAuth boundary через локальний
  `fetch` fake;
- повторний Telegram update та timeout Google OAuth. Помилки D1 і Vectorize
  додатково перевіряє швидкий Node-набір у `tests/tools-weekly.test.ts` та
  `tests/memory-core.test.ts`.

Запускайте runtime-набір разом із `npm run typecheck` перед змінами Worker
binding-ів, D1 schema, webhook-маршрутів або Workflow-класів.
