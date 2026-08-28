// Фліп ASSISTANT_V2=on (етап 2 PR-7b). Один рядок конфігу міняє чотири речі
// одразу, і кожна з них - місце, де прод міг би тихо зламатися. Тест пінить
// саме наслідки, а не значення прапорця: значення видно й так, а от «легасі
// більше не тікає» і «KV-гілка мовчить» інакше ніхто не помітить.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '..');
const config = readFileSync(join(ROOT, 'web', 'wrangler.jsonc'), 'utf8');

describe('прапорець у конфігу', () => {
  it('ASSISTANT_V2 = on і живе у vars, а не в дашборді', () => {
    expect(config).toMatch(/"ASSISTANT_V2":\s*"on"/);
    // Значення з дашборда не пережило б наступного wrangler deploy.
    const varsAt = config.indexOf('"vars"');
    const flagAt = config.indexOf('"ASSISTANT_V2"');
    expect(varsAt).toBeGreaterThan(0);
    expect(flagAt).toBeGreaterThan(varsAt);
  });
});

describe('наслідки on у коді', () => {
  const worker = readFileSync(join(ROOT, 'web', 'worker.js'), 'utf8');
  const tasks = readFileSync(join(ROOT, 'web', 'core', 'scheduler', 'tasks.mjs'), 'utf8');
  const schedulerDo = readFileSync(join(ROOT, 'web', 'core', 'scheduler', 'do.mjs'), 'utf8');

  it('легасі-цикл крону НЕ запускається при on (його задачі веде планувальник)', () => {
    expect(worker).toContain(
      "if (env.ASSISTANT_V2 !== 'on') ctx.waitUntil(runCronTasks(CRON_TASKS, env))",
    );
  });

  it('KV-гілка нагадувань мовчить при on - джерело D1', () => {
    // Інакше у вікні міграції запис лежить в обох сховищах, і власник
    // отримує дві копії одного нагадування.
    expect(tasks).toContain("if (env.ASSISTANT_V2 !== 'on') {");
    expect(tasks).toContain('await deliverDueReminders(env)');
  });

  it('при on виконуються ВСІ задачі планувальника, не лише shadowSafe', () => {
    expect(schedulerDo).toContain("if (env.ASSISTANT_V2 !== 'on' && !def.shadowSafe)");
  });
});
