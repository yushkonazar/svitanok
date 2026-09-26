// Ізольована операційна проба OpenAI hosted file search.
//
// Це НЕ production tool і НЕ шлях імпорту: він ніколи не читає Drive, D1, KV,
// файлову систему чи аргументи командного рядка. Єдиний payload — цей
// вбудований synthetic текст. Запуск потребує точного opt-in environment
// marker; наприкінці видаляються і vector store, і backing File.

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FILE_SEARCH_EXPERIMENT_OPT_IN = 'synthetic-only';
export const SYNTHETIC_MARKER = 'SVITANOK_SYNTHETIC_FILE_SEARCH_7F3A';
export const SYNTHETIC_DOCUMENT = [
  'Це штучний документ для технічної перевірки OpenAI File Search.',
  `Його єдиний маркер: ${SYNTHETIC_MARKER}.`,
  'У ньому немає персональних даних, секретів або тексту користувача.',
].join('\n');
export const SYNTHETIC_QUERY = 'Який точний маркер містить тестовий документ?';

const API_ROOT = 'https://api.openai.com/v1';
const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 750;

/** @typedef {{ apiKey: string, model: string }} ExperimentConfig */
/** @typedef {{ fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number, signal?: AbortSignal }} ExperimentDeps */

/**
 * Fail closed: accidental `npm run eval:file-search` is inert unless the
 * caller explicitly acknowledges that this is synthetic-only work.
 * @param {Record<string, string|undefined>} env
 * @returns {ExperimentConfig}
 */
export function loadSyntheticExperimentConfig(env) {
  if (env.OPENAI_FILE_SEARCH_EXPERIMENT !== FILE_SEARCH_EXPERIMENT_OPT_IN) {
    throw new Error(
      `Файловий experiment вимкнений. Задай OPENAI_FILE_SEARCH_EXPERIMENT=${FILE_SEARCH_EXPERIMENT_OPT_IN}.`,
    );
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY не задано: experiment не запущено.');
  const model =
    env.OPENAI_FILE_SEARCH_EXPERIMENT_MODEL?.trim() ||
    env.OPENAI_MODEL_STANDARD?.trim() ||
    'gpt-6-sol';
  return { apiKey, model };
}

/** @param {unknown} value @param {string} field */
function id(value, field) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
    throw new Error(`File Search experiment: відповідь без ${field}.`);
  }
  return value.id;
}

/** Не виводимо тіло помилки провайдера: воно може містити уривки request-а. */
async function requestJson(/** @type {typeof fetch} */ fetchFn, url, apiKey, init) {
  const response = await fetchFn(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`OpenAI File Search HTTP ${response.status}`);
  return body;
}

/** @param {unknown} output */
function completedFileSearchWithMarker(output) {
  if (!Array.isArray(output)) return false;
  return output.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.type === 'file_search_call' &&
      item.status === 'completed' &&
      // `include=file_search_call.results` gives evidence from the actual
      // retrieval call. JSON is inspected only in memory and never logged.
      JSON.stringify(item.search_results ?? '').includes(SYNTHETIC_MARKER),
  );
}

/** @param {unknown} value */
function completed(value) {
  return Boolean(value && typeof value === 'object' && value.status === 'completed');
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs exactly one synthetic, disposable hosted-file test. Its sole purpose
 * is to prove the external API sequence and cleanup semantics; it is not a
 * quality evaluation on an owner document and it is never called by runtime.
 * @param {ExperimentConfig} config
 * @param {ExperimentDeps} [deps]
 */
export async function runSyntheticFileSearchExperiment(config, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const signal = deps.signal ?? AbortSignal.timeout(45_000);
  const started = now();
  let fileId = null;
  let vectorStoreId = null;
  let primaryError = null;
  let result = null;
  /** @type {string[]} */
  const cleanupErrors = [];
  const cleanup = { vectorStoreDeleted: false, fileDeleted: false };

  try {
    const fileForm = new FormData();
    // `user_data` is the currently documented purpose for Files used by
    // Retrieval/File Search, rather than the legacy Assistants-only purpose.
    fileForm.set('purpose', 'user_data');
    fileForm.set(
      'file',
      new Blob([SYNTHETIC_DOCUMENT], { type: 'text/plain' }),
      'svitanok-synthetic-file-search.txt',
    );
    const uploaded = await requestJson(fetchFn, `${API_ROOT}/files`, config.apiKey, {
      method: 'POST',
      body: fileForm,
      signal,
    });
    fileId = id(uploaded, 'file id');

    const store = await requestJson(fetchFn, `${API_ROOT}/vector_stores`, config.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `svitanok-synthetic-file-search-${randomUUID()}`,
        // Secondary cleanup guard: manual finally cleanup is still required.
        expires_after: { anchor: 'last_active_at', days: 1 },
      }),
      signal,
    });
    vectorStoreId = id(store, 'vector store id');

    await requestJson(
      fetchFn,
      `${API_ROOT}/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
      config.apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fileId,
          attributes: { experiment: 'synthetic_only', source: 'svitanok' },
        }),
        signal,
      },
    );

    let indexed = false;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const attachment = await requestJson(
        fetchFn,
        `${API_ROOT}/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileId)}`,
        config.apiKey,
        { method: 'GET', signal },
      );
      if (completed(attachment)) {
        indexed = true;
        break;
      }
      if (attachment && typeof attachment === 'object' && attachment.status === 'failed') {
        throw new Error('OpenAI File Search: індексація synthetic файла не вдалася.');
      }
      await sleep(POLL_DELAY_MS);
    }
    if (!indexed)
      throw new Error('OpenAI File Search: вичерпано очікування індексації synthetic файла.');

    const response = await requestJson(fetchFn, `${API_ROOT}/responses`, config.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        input: SYNTHETIC_QUERY,
        store: false,
        include: ['file_search_call.results'],
        tools: [
          {
            type: 'file_search',
            vector_store_ids: [vectorStoreId],
            max_num_results: 2,
          },
        ],
      }),
      signal,
    });
    if (!completed(response) || !completedFileSearchWithMarker(response.output)) {
      throw new Error('OpenAI File Search: synthetic response не підтвердила retrieval.');
    }

    result = {
      ok: true,
      syntheticOnly: true,
      model: config.model,
      indexed: true,
      fileSearchVerified: true,
      // No ids, provider text or request fragments in the report/logs.
      durationMs: Math.max(0, now() - started),
      cleanup,
    };
  } catch (error) {
    primaryError =
      error instanceof Error ? error : new Error('OpenAI File Search experiment failed.');
  } finally {
    if (vectorStoreId) {
      try {
        await requestJson(
          fetchFn,
          `${API_ROOT}/vector_stores/${encodeURIComponent(vectorStoreId)}`,
          config.apiKey,
          { method: 'DELETE', signal },
        );
        cleanup.vectorStoreDeleted = true;
      } catch {
        cleanupErrors.push('vector store');
      }
    }
    if (fileId) {
      try {
        await requestJson(
          fetchFn,
          `${API_ROOT}/files/${encodeURIComponent(fileId)}`,
          config.apiKey,
          {
            method: 'DELETE',
            signal,
          },
        );
        cleanup.fileDeleted = true;
      } catch {
        cleanupErrors.push('file');
      }
    }
  }

  const messages = [
    primaryError?.message,
    cleanupErrors.length ? `cleanup: ${cleanupErrors.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  if (messages) throw new Error(messages);
  if (!result) throw new Error('OpenAI File Search experiment failed.');
  return result;
}

async function main() {
  if (process.argv.slice(2).length) {
    throw new Error(
      'Цей experiment не приймає шляхів чи payload-аргументів: лише вбудований synthetic текст.',
    );
  }
  const result = await runSyntheticFileSearchExperiment(loadSyntheticExperimentConfig(process.env));
  console.log(
    `PASS file-search synthetic-only model=${result.model} indexed=${result.indexed} retrieval=${result.fileSearchVerified} cleanup=vector-store:${result.cleanup.vectorStoreDeleted},file:${result.cleanup.fileDeleted} duration_ms=${result.durationMs}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // The message contains only local state/status; no response body or key.
    console.error(error instanceof Error ? error.message : 'OpenAI File Search experiment failed.');
    process.exitCode = 1;
  });
}
