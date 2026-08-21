// Клієнт власного LLM-хоста (Фаза 5, модуляризація worker.js, план A2 §5).
//
// Хост — це VPS із `claude` CLI на підписці (host/), а не платний API. Worker
// звертається до нього двома способами:
//   `/llm`   (callLlmHost)  — ОДИН синхронний виклик: рерайт фрази нагадування;
//   `/agent` (startAgentRun) — ЗАПУСК багатокрокового прогону, який далі сам
//                              стукає назад у /api/agent-step.
//
// ІНВАРІАНТ НА ВЕСЬ ФАЙЛ: жодна гілка НЕ КИДАЄ. Замість цього — {ok:false,
// status, error} з ПРИЧИНОЮ (A1): ліміт підписки, rate-limit, таймаут, хост
// лежить, не налаштовано. Раніше будь-який збій колапсував у глухий null, і
// «асистент не працює» неможливо було відрізнити від «я погано сформулював» —
// ні власнику, ні по логах. Текст для людини робить agent-core
// (classifyLlmFailure/assistantErrorReply), тут лише чесна причина.

/**
 * Тонкий клієнт власного LLM-хоста (host/, VPS на claude CLI — Блок P2, підписка,
 * не платний API). Graceful degradation зберігається: жодна гілка не кидає.
 *
 * A1: замість глухого `null` на будь-який збій повертає ПРИЧИНУ —
 * {ok:false, status, error} (status: HTTP-код або 0 для мережі/таймауту/
 * ненала­штованості). Виклики, яким байдуже (reminder-rewrite), і далі просто
 * читають `res?.structured` -> undefined; асистент мапить причину в людський
 * текст (classifyLlmFailure/assistantErrorReply, agent-core.mjs). Тіло помилки
 * хоста — це фіксований енум ('usage-limit'/'rate-limited'/'timeout'/…) або
 * текст CLI, який хост уже пропустив через власну класифікацію.
 *
 * @param {Env} env
 * @param {{ prompt: string, systemPrompt?: string, jsonSchema?: KvBlob,
 *           model?: string, timeoutMs?: number }} opts
 * @returns {Promise<KvBlob>} {ok:true,…} від хоста або {ok:false,status,error}
 */
export async function callLlmHost(env, { prompt, systemPrompt, jsonSchema, model, timeoutMs }) {
  if (!env.LLM_HOST_URL || !env.LLM_HOST_SECRET) {
    return { ok: false, status: 0, error: 'not-configured' };
  }
  const ctrl = new AbortController();
  // 25с — стеля (менше за таймаут хоста 30с). Агент передає МЕНШЕ: у нього свій
  // бюджет на весь ланцюжок, і один повільний виклик не сміє зʼїсти його весь.
  // Локальна змінна лише заради звуження типу: Number.isFinite істинний тільки
  // для чисел, але компілятору цього не повідомляє. Поведінка та сама.
  const t = typeof timeoutMs === 'number' ? timeoutMs : NaN;
  const ms = Number.isFinite(t) ? Math.max(1000, Math.min(25_000, t)) : 25_000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(env.LLM_HOST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      // model опційна — undefined випадає з JSON.stringify, хост тоді бере свій
      // DEFAULT_MODEL (haiku). Так reminder-rewrite лишається на haiku, а
      // асистент-агент передає 'sonnet' явно (CC2).
      body: JSON.stringify({ prompt, systemPrompt, jsonSchema, model }),
      signal: ctrl.signal,
    });
    // Тіло читаємо ОДИН раз (Response.body — стрім, .text() після .json() кине).
    const raw = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* не-JSON тіло (проксі/502-сторінка) -> data лишається null */
    }
    if (!res.ok || !data?.ok) {
      console.error('llm-host HTTP', res.status, raw.slice(0, 300));
      return {
        ok: false,
        status: res.status,
        error: typeof data?.error === 'string' ? data.error : `http-${res.status}`,
        ...(Number.isFinite(data?.resetAtMs) ? { resetAtMs: data.resetAtMs } : {}),
      };
    }
    return data;
  } catch (e) {
    // AbortError — це наш 25-секундний таймаут, не «хост лежить»: різні тексти.
    const err = /** @type {{ name?: unknown, message?: unknown }|null} */ (e);
    const aborted = err?.name === 'AbortError';
    console.error('llm-host call failed', err?.message);
    return { ok: false, status: 0, error: aborted ? 'timeout' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * URL роуту циклу на хості. LLM_HOST_URL указує на `/llm` (одноразовий виклик),
 * цикл живе поруч на `/agent`. Виводимо з наявного секрету, щоб перехід не
 * вимагав від власника заводити ще один; LLM_HOST_AGENT_URL — явний обхід, якщо
 * колись знадобиться інша адреса.
 * @param {Env} env
 * @returns {string|null}
 */
export function agentHostUrl(env) {
  if (env.LLM_HOST_AGENT_URL) return env.LLM_HOST_AGENT_URL;
  if (!env.LLM_HOST_URL) return null;
  return /\/llm\/?$/.test(env.LLM_HOST_URL)
    ? env.LLM_HOST_URL.replace(/\/llm\/?$/, '/agent')
    : `${env.LLM_HOST_URL.replace(/\/$/, '')}/agent`;
}

/**
 * Запустити прогін на хості: POST і одразу назад. Хост мусить відповісти 202 ДО
 * того, як почне думати — інакше ми знову чекали б у waitUntil і повернулись би
 * до тієї самої мовчанки. Форма відповіді при збої — як у callLlmHost, щоб
 * assistantErrorReply класифікувала причину тим самим кодом.
 * @param {Env} env
 * @param {KvBlob} payload
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function startAgentRun(env, payload) {
  const url = agentHostUrl(env);
  if (!url || !env.LLM_HOST_SECRET) return { ok: false, status: 0, error: 'not-configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* не-JSON (проксі/502-сторінка) */
    }
    if (!res.ok || !data?.ok) {
      console.error('agent start HTTP', res.status, raw.slice(0, 300));
      return {
        ok: false,
        status: res.status,
        error: typeof data?.error === 'string' ? data.error : `http-${res.status}`,
      };
    }
    return { ok: true };
  } catch (e) {
    const err = /** @type {{ name?: unknown, message?: unknown }|null} */ (e);
    console.error('agent start failed', err?.message);
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
