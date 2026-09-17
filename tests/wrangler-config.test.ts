import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/* Конфіг деплою — не код, тож жоден інший тест його не бачить. А ціна помилки
 * тут висока з двох боків: биту JSONC Cloudflare відхилить уже на деплої, а
 * прибраний `workers_dev` тихо підніме назад публічний *.workers.dev — адресу
 * ПОЗА зоною yushko.dev, якою обходяться і WAF, і rate limit на /api/* (S3). */

const raw = readFileSync(new URL('../web/wrangler.jsonc', import.meta.url), 'utf8');

/** JSONC -> обʼєкт. Коментарі в цьому файлі — лише цілорядкові, тож рядковий
 *  фільтр коректний; якщо колись зʼявиться `//` всередині значення, тест впаде
 *  на JSON.parse — гучно, а не мовчки. */
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'));
}

describe('web/wrangler.jsonc', () => {
  const cfg = parseJsonc(raw);

  it('парситься і не втратив базових полів', () => {
    expect(cfg.name).toBe('svitanok');
    expect(cfg.main).toBe('worker.js');
    expect(Array.isArray(cfg.kv_namespaces)).toBe(true);
  });

  it('публічні workers.dev і preview-URL вимкнені (S3)', () => {
    expect(cfg.workers_dev).toBe(false);
    // Ключ рівно ОДИН. Дубль (був: рядки 17 і 33) JSON.parse проковтує мовчки —
    // перемагає останній, тож розбіжні значення дали б конфіг, що не збігається
    // з тим, як його читає людина. Саме цей ключ вимикає адресу ПОЗА зоною
    // yushko.dev, якою обходяться WAF і rate limit.
    expect(raw.match(/"workers_dev"/g) ?? []).toHaveLength(1);
    // preview_urls за замовчуванням дорівнює workers_dev, але тримаємо явно —
    // щоб повернення однієї галки не вмикало мовчки другу.
    expect(cfg.preview_urls).toBe(false);
  });

  it('DO привʼязані й оголошені на SQLite-бекенді (Фаза 4 + етап 1 PR-2)', () => {
    // На Workers Free доступні ЛИШЕ SQLite-бекенди DO — легасі key-value клас
    // просто не задеплоївся б. І клас, і привʼязка мусять збігатись з ім'ям,
    // яке worker.js ре-експортує, інакше деплой падає на невідомому класі.
    const bindings = (cfg.durable_objects as { bindings: { name: string; class_name: string }[] })
      .bindings;
    expect(bindings).toEqual([
      { name: 'AGENT_RUN', class_name: 'AgentRun' },
      { name: 'SCHEDULER', class_name: 'SchedulerDO' },
      { name: 'RUN_REGISTRY', class_name: 'RunRegistryDO' },
      { name: 'STATE_STORE', class_name: 'StateStoreDO' },
      { name: 'PENDING_PROPOSALS', class_name: 'PendingProposalsDO' },
      { name: 'SENT_MESSAGES', class_name: 'SentMessagesDO' },
      { name: 'ASSISTANT_HISTORY', class_name: 'AssistantHistoryDO' },
      { name: 'ASSISTANT_RESUME', class_name: 'AssistantResumeDO' },
      { name: 'BRIEF_DISPATCH', class_name: 'BriefDispatchDO' },
    ]);
    expect(cfg.exports).toEqual({
      AgentRun: { type: 'durable-object', storage: 'sqlite' },
      SchedulerDO: { type: 'durable-object', storage: 'sqlite' },
      RunRegistryDO: { type: 'durable-object', storage: 'sqlite' },
      StateStoreDO: { type: 'durable-object', storage: 'sqlite' },
      PendingProposalsDO: { type: 'durable-object', storage: 'sqlite' },
      SentMessagesDO: { type: 'durable-object', storage: 'sqlite' },
      AssistantHistoryDO: { type: 'durable-object', storage: 'sqlite' },
      AssistantResumeDO: { type: 'durable-object', storage: 'sqlite' },
      BriefDispatchDO: { type: 'durable-object', storage: 'sqlite' },
    });
    // Легасі-масив `migrations` і `exports` взаємовиключні — тримаємо лише другий.
    expect(cfg.migrations).toBeUndefined();
    const worker = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
    expect(worker).toContain('export { AgentRun }');
    expect(worker).toContain('export { SchedulerDO }');
    expect(worker).toContain('export { RunRegistryDO }');
    expect(worker).toContain('export { StateStoreDO }');
    expect(worker).toContain('export { PendingProposalsDO }');
    expect(worker).toContain('export { SentMessagesDO }');
    expect(worker).toContain('export { AssistantHistoryDO }');
    expect(worker).toContain('export { AssistantResumeDO }');
    expect(worker).toContain('export { BriefDispatchDO }');
  });

  it('немає ключа routes — маршрути веде дашборд, wrangler їх не перезаписує', () => {
    // Кастомний домен (svitanok.yushko.dev) доданий у панелі. Щойно тут
    // зʼявиться `routes`, деплой почне вважати ЦЕЙ файл джерелом істини й зітре
    // все, чого в ньому немає.
    expect(cfg.routes).toBeUndefined();
  });
});
