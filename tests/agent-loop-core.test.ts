import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль хоста без типів (namespace-імпорт).
import * as loop from '../host/agent-loop-core.mjs';
// @ts-expect-error — JS-модуль хоста без типів.
import { MAX_PROMPT_LEN, MAX_SCHEMA_LEN } from '../host/llm-host-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { AGENT_MAX_STEPS } from '../web/agent-run-core.mjs';

const {
  MAX_AGENT_STEPS,
  AGENT_RUN_MAX_MS,
  WORKER_STEP_TIMEOUT_MS,
  clipAgentTranscript,
  validateAgentRequest,
  parseStepResponse,
  buildFailurePayload,
} = loop;

const okBody = (over: Record<string, unknown> = {}) => ({
  token: 'payload.signature',
  transcript: 'Користувач написав: "що в мене завтра?"',
  systemPrompt: 'Ти асистент.',
  jsonSchema: { type: 'object', properties: { action: { type: 'string' } } },
  model: 'sonnet',
  ...over,
});

describe('validateAgentRequest', () => {
  it('приймає повний коректний запит', () => {
    const res = validateAgentRequest(okBody());
    expect(res.ok).toBe(true);
    expect(res.value.model).toBe('sonnet');
    expect(res.value.schemaStr).toContain('action');
  });

  it('systemPrompt і jsonSchema опційні', () => {
    const res = validateAgentRequest({ token: 't.s', transcript: 'привіт' });
    expect(res.ok).toBe(true);
    expect(res.value.systemPrompt).toBeUndefined();
    expect(res.value.schemaStr).toBeUndefined();
  });

  it('відкидає запит без токена — без нього крок нікуди віддати', () => {
    expect(validateAgentRequest(okBody({ token: undefined })).error).toBe('no-token');
    expect(validateAgentRequest(okBody({ token: '   ' })).error).toBe('no-token');
    expect(validateAgentRequest(okBody({ token: 'x'.repeat(5000) })).error).toBe('token-too-long');
  });

  it('відкидає порожній або завеликий транскрипт', () => {
    expect(validateAgentRequest(okBody({ transcript: '' })).error).toBe('no-transcript');
    expect(validateAgentRequest(okBody({ transcript: 'я'.repeat(MAX_PROMPT_LEN + 1) })).error).toBe(
      'prompt-too-long',
    );
  });

  it('відкидає схему-масив і завелику схему', () => {
    expect(validateAgentRequest(okBody({ jsonSchema: [] })).error).toBe('bad-schema');
    expect(
      validateAgentRequest(okBody({ jsonSchema: { s: 'я'.repeat(MAX_SCHEMA_LEN) } })).error,
    ).toBe('schema-too-long');
  });

  /* model іде прямо в argv claude CLI. Валідація сувора — не тому, що spawn
     без shell лишає інʼєкцію можливою (не лишає), а щоб зіпсоване значення не
     стало прапорцем CLI. */
  it('відкидає модель зі спецсимволами', () => {
    for (const model of ['--dangerously-skip', 'a b', 'модель', 'x'.repeat(41)]) {
      expect(validateAgentRequest(okBody({ model })).ok).toBe(false);
    }
  });

  it('сміття замість тіла не кидає', () => {
    for (const bad of [null, undefined, 'рядок', 42, []]) {
      expect(validateAgentRequest(bad).ok).toBe(false);
    }
  });
});

describe('clipAgentTranscript', () => {
  it('короткий транскрипт не чіпає', () => {
    expect(clipAgentTranscript('коротко')).toBe('коротко');
  });

  /* ⚠️ Головна властивість: наївне обрізання з кінця викинуло б САМЕ ПИТАННЯ
     користувача (воно на початку), і модель на 6-му кроці вже не знала б, що
     робить. Обрізання з початку викинуло б свіжі дані інструментів. */
  it('зберігає і голову (запит), і хвіст (свіжі дані)', () => {
    const head = 'Користувач написав: "знайди лист від kontramarka"';
    const tail = 'Календар (2026-07-19): порожньо.';
    const out = clipAgentTranscript(`${head}${'\nсміття'.repeat(20_000)}\n${tail}`);
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_LEN);
    expect(out).toContain('kontramarka');
    expect(out).toContain('Календар (2026-07-19)');
    expect(out).toContain('обрізано'); // модель бачить, що дані неповні
  });

  it('поважає переданий менший бюджет', () => {
    const out = clipAgentTranscript('я'.repeat(5000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('parseStepResponse', () => {
  it('done:true -> фінал, петлі більше немає', () => {
    expect(parseStepResponse({ ok: true, done: true })).toEqual({ kind: 'done' });
  });

  it('крок із текстом і новим токеном -> continue', () => {
    expect(
      parseStepResponse({ ok: true, done: false, append: 'Пошта: 2 листи.', token: 'n.s' }),
    ).toEqual({ kind: 'continue', append: 'Пошта: 2 листи.', token: 'n.s' });
  });

  /* Петля крутиться від відповідей Worker'а, тож будь-яка неповна відповідь
     мусить її ЗУПИНЯТИ, а не крутити вічно на старому токені. */
  it('відсутній наступний токен зупиняє петлю', () => {
    expect(parseStepResponse({ ok: true, done: false, append: 'дані' })).toEqual({
      kind: 'stop',
      error: 'no-next-token',
    });
  });

  it('відмова Worker’а зупиняє петлю з його причиною', () => {
    expect(parseStepResponse({ ok: false, error: 'expired', done: true })).toEqual({
      kind: 'done',
    });
    expect(parseStepResponse({ ok: false, error: 'bad-signature' })).toEqual({
      kind: 'stop',
      error: 'bad-signature',
    });
  });

  it('битий/порожній JSON зупиняє петлю', () => {
    for (const bad of [null, undefined, 'рядок', 42]) {
      expect(parseStepResponse(bad).kind).toBe('stop');
    }
  });

  it('обрізає задовгий append (Worker свій, але петля не має роздувати транскрипт)', () => {
    const res = parseStepResponse({
      ok: true,
      done: false,
      append: 'я'.repeat(50_000),
      token: 't.s',
    });
    expect(res.append.length).toBeLessThanOrEqual(8000);
  });
});

describe('buildFailurePayload', () => {
  it('переносить причину і час скидання ліміту', () => {
    expect(
      buildFailurePayload({ ok: false, error: 'usage-limit', resetAtMs: 1_752_620_400_000 }),
    ).toEqual({ status: 502, error: 'usage-limit', resetAtMs: 1_752_620_400_000 });
  });

  it('без resetAtMs поле не вигадується', () => {
    expect(buildFailurePayload({ ok: false, error: 'timeout' })).toEqual({
      status: 502,
      error: 'timeout',
    });
  });

  it('порожній збій деградує в стабільний код, а не в undefined', () => {
    expect(buildFailurePayload(null).error).toBe('llm-error');
  });
});

/* ══ Сам цикл ══════════════════════════════════════════════════════════════
   Найризикованіший код переходу: він крутиться у фоні після 202, тож будь-яка
   не спіймана помилка тут поклала б процес разом з усіма прогонами. І/O
   інʼєктується, тож усі гілки перевіряються без мережі й без spawn'ів. */
describe('runAgentLoop', () => {
  type Step = Record<string, unknown>;
  const setup = (
    cliResults: Array<Record<string, unknown>>,
    workerResults: Array<Record<string, unknown>>,
  ) => {
    const cliCalls: unknown[] = [];
    const workerCalls: Step[] = [];
    let cliIdx = 0;
    let wIdx = 0;
    return {
      cliCalls,
      workerCalls,
      deps: {
        buildArgs: (a: unknown) => a,
        runClaude: async (args: unknown) => {
          cliCalls.push(args);
          return cliResults[Math.min(cliIdx++, cliResults.length - 1)];
        },
        callWorkerStep: async (body: Step) => {
          workerCalls.push(body);
          return workerResults[Math.min(wIdx++, workerResults.length - 1)];
        },
        log: () => {},
      },
    };
  };
  const run = (deps: Record<string, unknown>) =>
    (loop.runAgentLoop as (d: unknown, p: unknown) => Promise<{ outcome: string; steps: number }>)(
      deps,
      { token: 't0.s', transcript: 'Користувач написав: "що завтра?"', model: 'sonnet' },
    );

  it('ланцюжок читання -> фінальна дія: транскрипт росте, токен оновлюється', async () => {
    const { deps, cliCalls, workerCalls } = setup(
      [
        { ok: true, structured: { action: 'readMail' } },
        { ok: true, structured: { action: 'reply', replyText: 'ок' } },
      ],
      [
        { ok: true, done: false, append: 'Пошта: 1 лист.', token: 't1.s' },
        { ok: true, done: true },
      ],
    );
    const res = await run(deps);
    expect(res).toEqual({ outcome: 'done', steps: 2 });
    // Другий виклик CLI бачить дописаний результат інструмента...
    expect(String((cliCalls[1] as { prompt: string }).prompt)).toContain('Пошта: 1 лист.');
    // ...і йде вже з НОВИМ токеном (старий Worker відхилив би як переступлений).
    expect(workerCalls[1]?.token).toBe('t1.s');
  });

  it('логує usage КОЖНОГО кроку — саме тут видно, чи кешується статичний префікс (C1)', async () => {
    // Питання, заради якого це існує: системний промпт + схема (≈2000+3000
    // символів) їдуть у КОЖЕН spawn заново. Якщо `claude -p` їх кешує, на
    // кроці 2+ cacheRead має бути ненульовим. Досі в логах не було жодного
    // числа, тож відповідь була здогадкою — а від неї залежить, чи є сенс
    // у C2 (стабілізація префікса) і чи не потрібен перехід на Messages API.
    const lines: string[] = [];
    const { deps } = setup(
      [
        {
          ok: true,
          structured: { action: 'readMail' },
          usage: { input_tokens: 2400, output_tokens: 20, cache_read_input_tokens: 0 },
        },
        {
          ok: true,
          structured: { action: 'reply', replyText: 'ок' },
          usage: { input_tokens: 600, output_tokens: 30, cache_read_input_tokens: 1800 },
        },
      ],
      [
        { ok: true, done: false, append: 'Пошта: 1 лист.', token: 't1.s' },
        { ok: true, done: true },
      ],
    );
    deps.log = (...args: unknown[]) => void lines.push(args.join(' '));

    await run(deps);

    const usageLines = lines.filter((l) => l.includes('cacheRead'));
    expect(usageLines).toHaveLength(2);
    expect(usageLines[0]).toContain('крок 0');
    expect(usageLines[0]).toContain('cacheRead=0');
    expect(usageLines[1]).toContain('крок 1');
    expect(usageLines[1]).toContain('cacheRead=1800');
  });

  it('збій CLI -> звіт Worker’у з причиною, петля зупиняється', async () => {
    const { deps, workerCalls } = setup(
      [{ ok: false, error: 'usage-limit', resetAtMs: 1_752_620_400_000 }],
      [{ ok: true, done: true }],
    );
    const res = await run(deps);
    expect(res.outcome).toBe('llm-failed');
    expect(workerCalls[0]?.failure).toEqual({
      status: 502,
      error: 'usage-limit',
      resetAtMs: 1_752_620_400_000,
    });
    expect(workerCalls[0]?.structured).toBeUndefined();
  });

  it('Worker відхилив крок (протух токен) -> зупиняємось БЕЗ повторного звіту', async () => {
    const { deps, workerCalls } = setup(
      [{ ok: true, structured: { action: 'readMail' } }],
      [{ ok: false, error: 'expired' }],
    );
    const res = await run(deps);
    expect(res.outcome).toBe('stopped');
    expect(workerCalls).toHaveLength(1); // не тарабанимо мертвий прогін
  });

  it('модель нескінченно читає -> стеля кроків, звіт max-steps', async () => {
    const { deps, cliCalls, workerCalls } = setup(
      [{ ok: true, structured: { action: 'readMail' } }],
      [{ ok: true, done: false, append: 'ще дані', token: 'tN.s' }],
    );
    const res = await run(deps);
    expect(res).toEqual({ outcome: 'max-steps', steps: MAX_AGENT_STEPS });
    expect(cliCalls).toHaveLength(MAX_AGENT_STEPS);
    expect(workerCalls.at(-1)?.failure).toEqual({ status: 0, error: 'max-steps' });
  });

  it('прогін, що затягнувся, обривається за AGENT_RUN_MAX_MS', async () => {
    const { deps, workerCalls } = setup(
      [{ ok: true, structured: { action: 'readMail' } }],
      [{ ok: true, done: false, append: 'дані', token: 'tN.s' }],
    );
    let t = 0;
    const res = await (
      loop.runAgentLoop as (d: unknown, p: unknown) => Promise<{ outcome: string }>
    )(
      { ...deps, now: () => (t += AGENT_RUN_MAX_MS / 2) },
      { token: 't0.s', transcript: 'питання' },
    );
    expect(res.outcome).toBe('run-timeout');
    expect(workerCalls.at(-1)?.failure).toEqual({ status: 0, error: 'timeout' });
  });

  /* ⚠️ Інваріант, важливіший за решту: цикл крутиться у фоні після 202, тож не
     спійманий reject тут поклав би ВЕСЬ процес (unhandledRejection -> exit 1)
     разом з іншими прогонами. */
  it('падіння інструмента НЕ кидає назовні, а звітує Worker’у', async () => {
    const workerCalls: Step[] = [];
    const res = await (
      loop.runAgentLoop as (d: unknown, p: unknown) => Promise<{ outcome: string }>
    )(
      {
        buildArgs: (a: unknown) => a,
        runClaude: async () => {
          throw new Error('spawn ENOENT');
        },
        callWorkerStep: async (b: Step) => {
          workerCalls.push(b);
          return { ok: true, done: true };
        },
        log: () => {},
      },
      { token: 't0.s', transcript: 'питання' },
    );
    expect(res.outcome).toBe('crashed');
    expect(workerCalls[0]?.failure).toEqual({ status: 0, error: 'loop-crashed' });
  });

  it('навіть недоступний Worker не валить цикл (звіт про провал теж може впасти)', async () => {
    const res = await (
      loop.runAgentLoop as (d: unknown, p: unknown) => Promise<{ outcome: string }>
    )(
      {
        buildArgs: (a: unknown) => a,
        runClaude: async () => ({ ok: false, error: 'timeout' }),
        callWorkerStep: async () => {
          throw new Error('ECONNREFUSED');
        },
        log: () => {},
      },
      { token: 't0.s', transcript: 'питання' },
    );
    expect(res.outcome).toBe('llm-failed'); // не 'crashed' — звіт обгорнуто окремо
  });
});

describe('бюджети циклу', () => {
  /* Головний запобіжник — підписаний ран-токен Worker'а (хост його не підробить).
     Локальна стеля хоста тримається З ЗАПАСОМ понад неї, щоб у нормі спрацьовував
     саме Worker і власник бачив осмислене «заплутався в кроках», а не мовчазний
     обрив петлі. */
  it('локальна стеля кроків не менша за Worker’ову', () => {
    expect(MAX_AGENT_STEPS).toBeGreaterThan(AGENT_MAX_STEPS);
  });

  it('таймаут кроку менший за стелю всього прогону', () => {
    expect(WORKER_STEP_TIMEOUT_MS).toBeLessThan(AGENT_RUN_MAX_MS);
  });
});
