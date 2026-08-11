import { describe, it, expect } from 'vitest';
import { USAGE_LIMIT_TEXTS, NON_LIMIT_TEXTS } from './usage-limit-fixtures.js';
// @ts-expect-error — JS-модуль хоста без типів (namespace-імпорт: prettier не
// розбиває на кілька рядків, тож ts-expect-error завжди на рядку помилки).
import * as core from '../host/llm-host-core.mjs';
const {
  MAX_PROMPT_LEN,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_SCHEMA_LEN,
  verifySecret,
  validateLlmRequest,
  buildClaudeArgs,
  parseClaudeOutput,
  formatUsage,
  createRateLimiter,
  detectUsageLimit,
  resolveBindHost,
  USAGE_LIMIT_ERROR,
} = core;

describe('llm-host-core — verifySecret', () => {
  it('точний збіг -> true; будь-яка відмінність/довжина/тип/порожнє -> false', () => {
    expect(verifySecret('s3cr3t', 's3cr3t')).toBe(true);
    expect(verifySecret('s3cr3T', 's3cr3t')).toBe(false);
    expect(verifySecret('short', 'longer-secret')).toBe(false);
    expect(verifySecret('', '')).toBe(false);
    expect(verifySecret(undefined, 'x')).toBe(false);
  });
});

describe('llm-host-core — validateLlmRequest', () => {
  it('валідний мінімальний запит (лише prompt)', () => {
    const r = validateLlmRequest({ prompt: '  нагадай через 20 хв  ' });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ prompt: 'нагадай через 20 хв', model: 'haiku' });
  });

  it('systemPrompt/jsonSchema/model — валідні проходять, некоректні типи -> помилка', () => {
    const ok = validateLlmRequest({
      prompt: 'x',
      systemPrompt: 'extract time',
      jsonSchema: { type: 'object' },
      model: 'sonnet',
    });
    expect(ok.ok).toBe(true);
    expect(ok.value.schemaStr).toBe(JSON.stringify({ type: 'object' }));
    expect(ok.value.model).toBe('sonnet');

    expect(validateLlmRequest({ prompt: 'x', systemPrompt: 42 }).error).toBe('bad-system-prompt');
    expect(validateLlmRequest({ prompt: 'x', jsonSchema: 'not-an-object' }).error).toBe(
      'bad-schema',
    );
    expect(validateLlmRequest({ prompt: 'x', jsonSchema: [] }).error).toBe('bad-schema');
    expect(validateLlmRequest({ prompt: 'x', jsonSchema: null }).error).toBe('bad-schema'); // явний null -> відхиляємо, не ігноруємо мовчки
    expect(validateLlmRequest({ prompt: 'x', model: 'rm -rf /' }).error).toBe('bad-model');
    expect(validateLlmRequest({ prompt: 'x', model: '../../etc' }).error).toBe('bad-model');
    // ⚠️ Регресія: регекс без якоря на перший символ (`^[a-z0-9-]+$`) пропускав
    // значення, що виглядають як прапорці CLI. spawn({shell:false}) інʼєкцію
    // команд не дає, але argv-слот після `--model` таким заповнювати не варто.
    expect(validateLlmRequest({ prompt: 'x', model: '--dangerously-skip-permissions' }).error).toBe(
      'bad-model',
    );
    expect(validateLlmRequest({ prompt: 'x', model: '-p' }).error).toBe('bad-model');
    // ...а нормальні alias'и й повні id мусять і далі проходити.
    for (const model of ['haiku', 'sonnet', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
      expect(validateLlmRequest({ prompt: 'x', model }).ok).toBe(true);
    }
  });

  it('відсутній/порожній/не-рядок prompt -> no-prompt; не-обʼєкт body -> bad-body', () => {
    expect(validateLlmRequest({}).error).toBe('no-prompt');
    expect(validateLlmRequest({ prompt: '   ' }).error).toBe('no-prompt');
    expect(validateLlmRequest({ prompt: 42 }).error).toBe('no-prompt');
    expect(validateLlmRequest(null).error).toBe('bad-body');
    expect(validateLlmRequest('string').error).toBe('bad-body');
  });

  it('ліміти довжини (prompt/systemPrompt/schema)', () => {
    expect(validateLlmRequest({ prompt: 'x'.repeat(MAX_PROMPT_LEN + 1) }).error).toBe(
      'prompt-too-long',
    );
    expect(
      validateLlmRequest({ prompt: 'x', systemPrompt: 'y'.repeat(MAX_SYSTEM_PROMPT_LEN + 1) })
        .error,
    ).toBe('system-prompt-too-long');
    // Від межі, а не від магічного числа: інакше кожне підняття ліміту тихо
    // перетворює цей рядок на перевірку «валідна схема валідна».
    expect(
      validateLlmRequest({ prompt: 'x', jsonSchema: { huge: 'z'.repeat(MAX_SCHEMA_LEN) } }).error,
    ).toBe('schema-too-long');
  });
});

describe('llm-host-core — buildClaudeArgs (безпековий локдаун)', () => {
  it('prompt — ОСТАННІЙ argv-елемент, одразу після "--" (ніколи не конкатенується в рядок)', () => {
    const args = buildClaudeArgs({ prompt: '; rm -rf / #`whoami`$(ls)' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('; rm -rf / #`whoami`$(ls)');
    // Жодного іншого елемента масиву не містить metacharacters як частину рядка-команди —
    // це просто ОДИН довільний argv, spawn(shell:false) ніколи це не інтерпретує.
    expect(args.filter((a: string) => a.includes('rm -rf'))).toHaveLength(1);
  });

  it('РЕГРЕС: prompt, що виглядає як реальний прапорець CLI, НЕ опиняється в позиції прапорця', () => {
    // Знайдено security-review: -p/--print — булевий перемикач commander'а
    // (НЕ valued-опція), тому prompt — окремий позиційний аргумент. Без "--"
    // перед ним значення на кшталт "--allow-dangerously-skip-permissions" чи
    // "--continue" парсились би CLI як СПРАВЖНІ прапорці, а не як текст.
    // Перевірено емпірично на реальному CLI (claude -p --help показує ЙОГО
    // --help, а не «відповідь» на текст "--help" — отже без "--" це не
    // безпечно; з "--" перед prompt — той самий рядок іде в модель як текст).
    for (const dangerous of [
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--continue',
      '-c',
      '--tools',
    ]) {
      const args = buildClaudeArgs({ prompt: dangerous });
      // Єдине допустиме місце для prompt — ОСТАННІЙ елемент, одразу за "--".
      expect(args[args.length - 1]).toBe(dangerous);
      expect(args[args.length - 2]).toBe('--');
      // "--" присутній РІВНО один раз (не переплутати з чимось у значеннях прапорців).
      expect(args.filter((a: string) => a === '--')).toHaveLength(1);
    }
  });

  it('завжди містить жорсткий локдаун (не конфігурований викликачем)', () => {
    const args = buildClaudeArgs({ prompt: 'x' });
    const pairs = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--tools');
    expect(pairs('--tools')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--setting-sources');
    expect(pairs('--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(pairs('--permission-mode')).toBe('default');
    expect(pairs('--output-format')).toBe('json');
    expect(pairs('--max-budget-usd')).toBe('0.20');
  });

  it('модель за замовчуванням haiku; systemPrompt/schemaStr — опційно додаються', () => {
    expect(buildClaudeArgs({ prompt: 'x' })).toContain('haiku');
    const args = buildClaudeArgs({
      prompt: 'x',
      systemPrompt: 'sys',
      schemaStr: '{"type":"object"}',
      model: 'sonnet',
    });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('sys');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('без systemPrompt/schemaStr — відповідні прапорці відсутні', () => {
    const args = buildClaudeArgs({ prompt: 'x' });
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('--json-schema');
  });
});

describe('llm-host-core — parseClaudeOutput', () => {
  it('успішний JSON із structured_output', () => {
    const stdout = JSON.stringify({
      result: '{"task":"x"}',
      structured_output: { task: 'x' },
      total_cost_usd: 0.0038,
      is_error: false,
    });
    expect(parseClaudeOutput(stdout)).toEqual({
      ok: true,
      result: '{"task":"x"}',
      structured: { task: 'x' },
      costUsd: 0.0038,
      usage: null,
    });
  });

  /* C1: чи `claude -p` узагалі кешує статичний префікс (системний промпт +
   * схема), який ми шлемо на КОЖНОМУ кроці агента? Досі це було припущення —
   * жодного числа. CLI віддає `usage` у тому ж JSON; просто прокидаємо його
   * назовні, щоб лог показав cache_read і питання стало емпіричним. */
  it('прокидає usage-блок CLI (cache_read/cache_creation — вимір кешу, C1)', () => {
    const stdout = JSON.stringify({
      result: 'ок',
      is_error: false,
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 1800,
        cache_creation_input_tokens: 0,
      },
    });
    const out = parseClaudeOutput(stdout);
    expect(out.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 0,
    });
  });

  it('formatUsage — компактний рядок для логів; без usage не бреше нулями', () => {
    expect(
      formatUsage({
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 1800,
        cache_creation_input_tokens: 5,
      }),
    ).toBe('in=12 out=34 cacheRead=1800 cacheCreate=5');
    // Немає блоку / немає поля -> прочерк. Нуль і «не повідомлено» — РІЗНІ
    // відповіді на питання «чи працює кеш», і плутати їх не можна.
    expect(formatUsage(null)).toBe('usage=-');
    expect(formatUsage({ input_tokens: 12 })).toBe('in=12 out=- cacheRead=- cacheCreate=-');
  });

  it('is_error:true -> ok:false з текстом помилки', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'overloaded' });
    expect(parseClaudeOutput(stdout)).toEqual({ ok: false, error: 'overloaded' });
  });

  it('невалідний JSON / не-обʼєкт -> ok:false bad-output', () => {
    expect(parseClaudeOutput('не json{{{').ok).toBe(false);
    expect(parseClaudeOutput('null').error).toBe('bad-output');
    expect(parseClaudeOutput('42').error).toBe('bad-output');
  });

  it('is_error через вичерпаний ліміт -> стабільний енум + resetAtMs (A1)', () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: 'Claude AI usage limit reached|1752620400',
    });
    expect(parseClaudeOutput(stdout)).toEqual({
      ok: false,
      error: USAGE_LIMIT_ERROR,
      resetAtMs: 1752620400 * 1000,
    });
  });
});

describe('llm-host-core — detectUsageLimit (A1)', () => {
  it('epoch у секундах -> resetAtMs у мс', () => {
    expect(detectUsageLimit('Claude AI usage limit reached|1752620400')).toEqual({
      limit: true,
      resetAtMs: 1752620400_000,
    });
  });

  it('epoch у мілісекундах лишається як є', () => {
    expect(detectUsageLimit('usage limit reached|1752620400000').resetAtMs).toBe(1752620400000);
  });

  it('двозначна довжина epoch (11–12 цифр) -> час не показуємо (ревʼю A)', () => {
    // ×1000 дало б 25-те століття; краще без часу, ніж із вигаданим.
    expect(detectUsageLimit('usage limit reached|17526204000')).toEqual({ limit: true });
    expect(detectUsageLimit('usage limit reached|175262040000')).toEqual({ limit: true });
  });

  it('ліміт без epoch -> limit:true без часу (нічого не вигадуємо)', () => {
    expect(detectUsageLimit("You've hit your session limit · resets 11pm")).toEqual({
      limit: true,
    });
    expect(detectUsageLimit('Weekly limit reached. Try again later.')).toEqual({ limit: true });
  });

  it('інші помилки — не ліміт', () => {
    expect(detectUsageLimit('overloaded').limit).toBe(false);
    expect(detectUsageLimit('').limit).toBe(false);
    expect(detectUsageLimit(null).limit).toBe(false);
  });

  it('паритет зі спільним фікстур-набором (host vs web vs src)', () => {
    for (const t of USAGE_LIMIT_TEXTS) expect(detectUsageLimit(t).limit, t).toBe(true);
    for (const t of NON_LIMIT_TEXTS) expect(detectUsageLimit(t).limit, t).toBe(false);
  });
});

describe('llm-host-core — resolveBindHost (S4: хост не висить на всіх інтерфейсах)', () => {
  it('за замовчуванням лише loopback — назовні пускає Caddy, а не сам процес', () => {
    // Доти server.listen(PORT) слухав 0.0.0.0, і єдиним, що тримало ендпоінт
    // приватним, був ufw. Одне невдале правило фаєрвола = відкритий в інтернет
    // спавнер підпроцесів. Caddy і так проксі на 127.0.0.1:8787 (host/README),
    // тож loopback нічого не ламає — просто прибирає цей клас помилки.
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ BIND_HOST: '' })).toBe('127.0.0.1');
    expect(resolveBindHost({ BIND_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('явний BIND_HOST шанується (інша топологія — контейнер, окремий проксі)', () => {
    expect(resolveBindHost({ BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ BIND_HOST: ' 10.0.0.5 ' })).toBe('10.0.0.5');
  });
});

describe('llm-host-core — createRateLimiter (фіксоване вікно)', () => {
  it('дозволяє до max у вікні, блокує понад, скидається в наступному вікні', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(100)).toBe(true);
    expect(rl.allow(200)).toBe(false); // 3-й у тому самому вікні
    expect(rl.allow(1000)).toBe(true); // нове вікно
    expect(rl.allow(1050)).toBe(true);
    expect(rl.allow(1060)).toBe(false);
  });
});
