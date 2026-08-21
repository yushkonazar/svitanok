// @ts-check
// Чиста логіка циклу агента на хості (варіант Б). І/O — server.mjs.
//
// НАВІЩО ЦИКЛ ТУТ. Доти його крутив Cloudflare Worker у ctx.waitUntil і впирався
// в стелю платформи: Cloudflare убиває фонову роботу МОВЧКИ на ~25-30с (бісект
// власника: 2 раунди відповідають, 3 дають повну тишу). На VPS часового ліміту
// немає, а claude CLI живе тут-таки — тобто кожен крок ще й економить два
// мережеві хопи.
//
// ЧОГО ЦЕЙ ФАЙЛ НЕ ЗНАЄ І НЕ МУСИТЬ ЗНАТИ. Переліку дій агента, їх семантики,
// секретів Google/Telegram, форми KV. Системний промпт і JSON-схему присилає
// Worker у самому запиті, а кожну обрану моделлю дію виконує теж Worker
// (`/api/agent-step`), у якого й лежать секрети. Хост лишається тим самим тонким
// реле, що й був: він крутить петлю, але не розуміє, що саме в ній відбувається.
//
// Практичний наслідок для деплою: нове вміння агента = правка ЛИШЕ Worker'а.
// Редеплой VPS потрібен, тільки якщо змінився САМ протокол (файли з цієї теки).

import {
  MAX_PROMPT_LEN,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_SCHEMA_LEN,
  MODEL_RE,
  formatUsage,
} from './llm-host-core.mjs';

/**
 * Стеля кроків — ДУБЛЮЄ AGENT_MAX_STEPS у web/agent-run-core.mjs НАВМИСНО.
 * Головний запобіжник — підписаний ран-токен Worker'а (його хост підробити не
 * може). Цей — локальний: якщо Worker раптом почне видавати токени без кінця,
 * петля тут усе одно зупиниться, а не спалить підписку в нескінченному циклі.
 * Тримаємо з невеликим запасом понад Worker'ів кап, щоб у нормі спрацьовував
 * саме він (і власник бачив осмислене «заплутався в кроках»).
 */
export const MAX_AGENT_STEPS = 12;

/** Скільки хост чекає на відповідь Worker'а по інструмент (Gmail/календар — мережа). */
export const WORKER_STEP_TIMEOUT_MS = 20_000;

/** Стеля життя всього прогону — останній запобіжник від зависання петлі. */
export const AGENT_RUN_MAX_MS = 4 * 60_000;

const MAX_TOKEN_LEN = 4000;
const MAX_APPEND_LEN = 8000;

/**
 * Обрізати транскрипт, зберігаючи ГОЛОВУ і ХВІСТ.
 *
 * Наївне обрізання з кінця викинуло б саме питання користувача (воно на початку)
 * — і модель на 6-му кроці вже не знала б, що взагалі робить. Обрізання з
 * початку викинуло б свіжі результати інструментів. Тож лишаємо початок
 * (історія + запит) і кінець (останні дані), а виріз позначаємо явно — щоб
 * модель бачила, що дані неповні, і не вигадувала відсутнє.
 */
export function clipAgentTranscript(/** @type {unknown} */ text, max = MAX_PROMPT_LEN) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const marker = '\n\n…(частину проміжних кроків обрізано)…\n\n';
  const budget = Math.max(0, max - marker.length);
  const head = Math.floor(budget * 0.3);
  const tail = budget - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}

/**
 * Валідувати тіло POST /agent -> {ok:true,value} | {ok:false,error}.
 * Ті самі капи, що й у /llm: хост стоїть в інтернеті й спавнить процеси.
 */
/**
 * ⚠️ Літеральні `true`/`false` в `ok` обовʼязкові: без них виведення розширює
 * поле до `boolean`, союз перестає розрізнятись, і викликач після
 * `if (!validated.ok) return` не отримує гарантії, що `value` є.
 * @param {any} body
 * @returns {{ ok: false, error: string }
 *   | { ok: true, value: { token: string, transcript: string, systemPrompt?: string,
 *                          schemaStr?: string, model?: string } }}
 */
export function validateAgentRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad-body' };
  const { token, transcript, systemPrompt, jsonSchema, model } = body;

  if (typeof token !== 'string' || !token.trim()) return { ok: false, error: 'no-token' };
  if (token.length > MAX_TOKEN_LEN) return { ok: false, error: 'token-too-long' };

  if (typeof transcript !== 'string' || !transcript.trim()) {
    return { ok: false, error: 'no-transcript' };
  }
  if (transcript.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt-too-long' };

  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') return { ok: false, error: 'bad-system-prompt' };
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_LEN) {
      return { ok: false, error: 'system-prompt-too-long' };
    }
  }

  let schemaStr;
  if (jsonSchema !== undefined) {
    if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) {
      return { ok: false, error: 'bad-schema' };
    }
    schemaStr = JSON.stringify(jsonSchema);
    if (schemaStr.length > MAX_SCHEMA_LEN) return { ok: false, error: 'schema-too-long' };
  }

  if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    return { ok: false, error: 'bad-model' };
  }

  return {
    ok: true,
    value: {
      token: token.trim(),
      transcript: transcript.trim(),
      systemPrompt: systemPrompt?.trim() || undefined,
      schemaStr,
      model: model || undefined,
    },
  };
}

/**
 * Розібрати відповідь Worker'а на крок.
 *
 * Захисно: Worker — свій, але петля крутиться від його відповідей, тож битий
 * JSON чи відсутній токен мусять зупиняти прогін, а не крутити його вічно.
 * `done:true` — фінал (Worker уже відповів власнику), далі петлі немає.
 */
export function parseStepResponse(/** @type {any} */ data) {
  if (!data || typeof data !== 'object') return { kind: 'stop', error: 'bad-step-response' };
  if (data.done === true) return { kind: 'done' };
  if (data.ok !== true) {
    return { kind: 'stop', error: typeof data.error === 'string' ? data.error : 'step-failed' };
  }
  const token = typeof data.token === 'string' ? data.token : '';
  if (!token) return { kind: 'stop', error: 'no-next-token' };
  const append = typeof data.append === 'string' ? data.append.slice(0, MAX_APPEND_LEN) : '';
  return { kind: 'continue', append, token };
}

/**
 * Звести збій CLI у форму, яку Worker уміє класифікувати (assistantErrorReply).
 * Сирий stderr сюди НЕ потрапляє — той самий інваріант, що в /llm.
 */
export function buildFailurePayload(/** @type {any} */ result) {
  return {
    status: 502,
    error: typeof result?.error === 'string' ? result.error : 'llm-error',
    ...(Number.isFinite(result?.resetAtMs) ? { resetAtMs: result.resetAtMs } : {}),
  };
}

/**
 * САМ ЦИКЛ. І/O інʼєктується (runClaude / callWorkerStep / buildArgs) — інакше
 * найризикованіший код проєкту жив би всередині server.mjs, який на імпорті
 * піднімає HTTP-сервер і не тестується взагалі.
 *
 * Інваріант, важливіший за решту: функція НІКОЛИ не кидає. Вона крутиться у
 * фоні після 202, а не спійманий reject поклав би процес разом з усіма іншими
 * прогонами (process.on('unhandledRejection') виходить із коду 1).
 *
 * Повертає {outcome, steps} — для логів і тестів.
 */
/**
 * @param {any} deps середовище прогону (fetch, spawn, log) — підміняється в тестах
 * @param {{ token: string, transcript: string, systemPrompt?: string,
 *           schemaStr?: string, model?: string }} req
 */
export async function runAgentLoop(deps, { token, transcript, systemPrompt, schemaStr, model }) {
  const {
    runClaude,
    callWorkerStep,
    buildArgs,
    now = () => Date.now(),
    log = console.error,
  } = deps;
  const startedMs = now();
  let currentToken = token;
  let currentTranscript = transcript;

  /* Повідомити Worker про провал — щоб власник отримав чесну причину, а не
     мовчанку. Сам звіт теж може впасти (мережа), і це вже нічим не рятується:
     тоді спрацює сторож Worker'а й скаже про обірваний запит. */
  const report = async (/** @type {any} */ failure) => {
    try {
      await callWorkerStep({ token: currentToken, failure });
    } catch (/** @type {any} */ e) {
      log('agent: не вдалось відзвітувати про провал:', e?.message);
    }
  };

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      if (now() - startedMs > AGENT_RUN_MAX_MS) {
        log(`agent: прогін перевищив ${AGENT_RUN_MAX_MS}мс на кроці ${step}`);
        await report({ status: 0, error: 'timeout' });
        return { outcome: 'run-timeout', steps: step };
      }

      const out = await runClaude(
        buildArgs({
          prompt: clipAgentTranscript(currentTranscript),
          systemPrompt,
          schemaStr,
          model,
        }),
      );
      if (out?.ok) {
        // C1 — телеметрія кешу. Саме тут вона й має сенс: системний промпт і
        // схема незмінні між кроками ОДНОГО прогону, тож ненульовий cacheRead
        // на кроці 1+ означає, що `claude -p` префікс кешує. Нулі на всіх
        // кроках означають протилежне — і тоді стабілізація префікса (C2) не
        // дасть нічого, а питання переходить у площину cost-моделі.
        log(`[agent] крок ${step}: ${formatUsage(out.usage)}`);
      }
      if (!out?.ok) {
        // Ліміт підписки / впав CLI / таймаут — Worker перекладе це власнику
        // людською мовою (той самий класифікатор, що й до переходу).
        log(`agent: CLI віддав збій на кроці ${step}:`, out?.error);
        await report(buildFailurePayload(out));
        return { outcome: 'llm-failed', steps: step };
      }

      const parsedStep = parseStepResponse(
        await callWorkerStep({ token: currentToken, structured: out.structured }),
      );
      if (parsedStep.kind === 'done') return { outcome: 'done', steps: step + 1 };
      if (parsedStep.kind === 'stop') {
        // Worker відхилив крок (протух токен, вичерпані кроки, збій). Відповідає
        // власнику він сам або сторож — нам лишається зупинитись.
        log(`agent: крок ${step} зупинено —`, parsedStep.error);
        return { outcome: 'stopped', steps: step + 1 };
      }
      currentTranscript += `\n\n${parsedStep.append}`;
      currentToken = parsedStep.token;
    }

    log(`agent: локальна стеля ${MAX_AGENT_STEPS} кроків вичерпана`);
    await report({ status: 0, error: 'max-steps' });
    return { outcome: 'max-steps', steps: MAX_AGENT_STEPS };
  } catch (/** @type {any} */ err) {
    log('agent: цикл упав —', err?.message);
    await report({ status: 0, error: 'loop-crashed' });
    return { outcome: 'crashed', steps: -1 };
  }
}
