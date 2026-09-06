// GitHub REST з ядра: слаг репозиторію і заголовки - в одному місці для
// dispatch брифінгу (cron.mjs) і аналізу ідеї (core/ideas/analysis.mjs).
//
// Env ПЕРЕКРИВАЄ слаг, а не вимагає його: форк чи перейменування не має
// означати правку коду, але й новий обовʼязковий секрет завів би прод у стан,
// де брифінг не диспатчиться, доки власник не поставить змінну. Дефолт -
// рівно те значення, що стояло зашитим.

export const DEFAULT_GH_REPO = 'yushkonazar/svitanok';
export const GITHUB_API = 'https://api.github.com';

/** `owner/repo` цього репозиторію. @param {Env} env */
export function ghRepoSlug(env) {
  return env.GH_REPO?.trim() || DEFAULT_GH_REPO;
}

/** Власник GitHub (перша частина слага). @param {Env} env */
export function ghOwner(env) {
  return ghRepoSlug(env).split('/')[0] ?? '';
}

/**
 * Заголовки запиту до GitHub API. accept - за замовчуванням JSON; для
 * `/commits/HEAD` - `application/vnd.github.sha` (сирий sha текстом).
 * @param {string} token @param {{ accept?: string, agent?: string, json?: boolean }} [opts]
 */
export function ghHeaders(token, opts = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: opts.accept ?? 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': opts.agent ?? 'svitanok',
    ...(opts.json ? { 'content-type': 'application/json' } : {}),
  };
}
