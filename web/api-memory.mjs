import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import {
  readMemoryWorkspace,
  validateMemoryCommand,
  executeMemoryCommand,
  MemoryOperationError,
} from './core/memory/workspace.mjs';
import { MEMORY_TYPES } from './core/memory/semantics.mjs';
import { MEMORY_VALUE_ERROR } from './core/memory/safety.mjs';

/** Private, lazy memory workspace. No new external sources or paid model calls.
 * @param {Request} request @param {Env} env */
export async function handleMemory(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  if (!['GET', 'POST'].includes(request.method))
    return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const parsed = request.method === 'POST' ? await readJsonBody(request) : null;
  if (parsed && !parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  const url = new URL(request.url),
    rawOffset = url.searchParams.get('offset') ?? '0';
  if (!/^\d{1,5}$/.test(rawOffset) || Number(rawOffset) > 10000)
    return reply({ ok: false, error: 'Неправильна сторінка пам’яті.' }, 400);
  const group = url.searchParams.get('group') ?? 'all',
    search = (url.searchParams.get('search') ?? '').trim();
  if (!['all', 'review', ...MEMORY_TYPES].includes(group) || search.length > 80)
    return reply({ ok: false, error: 'Неправильний фільтр пам’яті.' }, 400);
  const nowMs = Date.now();
  let command,
    acknowledged = false,
    message = '';
  if (request.method === 'POST') {
    try {
      command = validateMemoryCommand(body);
    } catch (/** @type {any} */ error) {
      return reply({ ok: false, error: error.message }, 400);
    }
    try {
      message = (await executeMemoryCommand(env, command, nowMs)).message;
      acknowledged = true;
    } catch (/** @type {any} */ error) {
      // Only controlled validation/conflict messages; raw provider/storage errors stay private.
      const text = String(error.message ?? '');
      const safe =
        error instanceof MemoryOperationError ||
        new Set([
          'Цей факт уже змінився. Перевір актуальне значення й повтори дію.',
          'Ця пропозиція пам’яті застаріла. Повтори запит, щоб зберегти актуальний факт.',
          'Цієї пропозиції вже немає. Онови пам’ять.',
          'Цю дію не можна виконати через екран пам’яті.',
          'Пропозиція пошкоджена. Надішли новий запит.',
          'Пропозиція вже закрита. Надішли новий запит.',
          'Час підтвердження минув. Надішли новий запит.',
          'Факт уже прибрано. Онови пам’ять.',
          MEMORY_VALUE_ERROR,
        ]).has(text);
      return reply(
        {
          ok: false,
          error: safe ? text : 'Не отримав підтвердження зміни. Онови пам’ять перед повтором.',
        },
        error instanceof MemoryOperationError ? error.status : safe ? 409 : 503,
      );
    }
  }
  try {
    return reply({
      ok: true,
      acknowledged,
      message,
      ...(await readMemoryWorkspace(
        env,
        nowMs,
        command ? 0 : Number(rawOffset),
        command ? { group: 'all', search: '' } : { group, search },
      )),
    });
  } catch {
    return acknowledged
      ? reply({
          ok: true,
          acknowledged: true,
          message,
          error: 'Рішення збережено, але показ не оновився. Онови пам’ять.',
        })
      : reply({ ok: false, error: 'Не вдалося завантажити пам’ять. Спробуй ще раз.' }, 503);
  }
}
