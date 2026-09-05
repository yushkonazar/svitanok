// Реєстр ідей (07 §1 `ideas`/`idea_events`, §4 `ideas.*`, S-3-1/2/6/7,
// етап 3 PR-4): create/update/analyze - T0 через policy з «↩», delete - T1,
// list/search - читання. Номер ідеї для власника («ідея #12») - rowid
// таблиці: ulid у чаті не вимовиш, а окремої колонки-лічильника канон не має
// і додавати міграцію заради номера не варто - rowid у SQLite стабільний для
// таблиці з TEXT PRIMARY KEY (без WITHOUT ROWID) і не повторюється після
// видалення, доки живий максимум (D1 дає саме таку таблицю).
//
// FTS (ideas_fts, ADR-036): синхронізацію веде код разом із записом у базову
// таблицю - DELETE + INSERT на кожну правку, бо таблиця standalone.
//
// Аналіз по коду (mode=code) - етап 4 (IdeaAnalysis Workflow + Actions):
// тут чесна відмова, а не тиха підміна планом.

/** Домени - дослівно 07 §1. */
export const IDEA_DOMAINS = ['svitanok', 'робота', 'побут', 'бізнес', 'інше'];
/** Статуси - дослівно 07 §1, у порядку життєвого циклу. */
export const IDEA_STATUSES = [
  'нова',
  'в аналізі',
  'план готовий',
  'погоджено',
  'у роботі',
  'зроблено',
  'відкладено',
  'відхилено',
];
export const IDEA_EFFORTS = ['S', 'M', 'L'];
/** Стеля списку (S-3-6: «список ≤ 10»). */
export const IDEAS_LIST_MAX = 10;
/** Кап тіла ідеї/аналізу/плану в базі: документ ≤ 3 500 у чаті або .md (S-3-2). */
export const IDEA_TEXT_MAX = 20_000;

/** Поля, які приймає update (усе інше в args ігнорується свідомо). */
const UPDATABLE = [
  'title',
  'body_md',
  'domain',
  'status',
  'priority',
  'effort',
  'next_action',
  'tags',
  'analysis_md',
  'plan_md',
];

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ideas недоступні');
  return env.DB;
}

/**
 * Ідея за посиланням власника: число - номер (rowid), інакше - id.
 * @param {Env} env
 * @param {unknown} ref
 * @returns {Promise<IdeaRow | null>}
 */
export async function findIdea(env, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const byNumber = /^#?(\d{1,9})$/.exec(s);
  const sql = `SELECT * FROM ideas WHERE ${byNumber ? 'number = ?' : 'id = ?'}`;
  const row = await db(env)
    .prepare(sql)
    .bind(byNumber ? Number(byNumber[1]) : s)
    .first();
  return /** @type {IdeaRow | null} */ (row ?? null);
}

/**
 * @typedef {{ number: number, id: string, title: string, body_md: string | null,
 *   domain: string | null, status: string, priority: number | null, effort: string | null,
 *   next_action: string | null, tags_json: string | null, analysis_md: string | null,
 *   plan_md: string | null, plan_approved_at: string | null, repo: string | null,
 *   created_at: string, updated_at: string }} IdeaRow
 */

/**
 * ideas.create (S-3-1): domain визначає модель, priority 2 за замовчуванням.
 * @param {Env} env
 * @param {{ title: string, body_md?: string, domain?: string, priority?: number,
 *   effort?: string, tags?: string[], next_action?: string, source_msg_id?: string }} args
 * @param {number} nowMs
 */
export async function runIdeasCreate(env, args, nowMs) {
  const title = String(args.title ?? '').trim();
  if (!title) throw new Error('title не може бути порожнім');
  const domain = args.domain ?? 'інше';
  if (!IDEA_DOMAINS.includes(domain)) {
    throw new Error(`невідомий domain "${domain}" (чинні: ${IDEA_DOMAINS.join(', ')})`);
  }
  const priority = normalizePriority(args.priority ?? 2);
  const effort = normalizeEffort(args.effort);
  const tags = normalizeTags(args.tags);
  const id = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  const body = clipText(args.body_md);
  const storedTitle = title.slice(0, 200);
  // Номер - з монотонного лічильника (міграція 0011): rowid після видалення
  // останнього рядка повторювався, і нова ідея ставала «#1» слідом за стертою.
  const counter = /** @type {{ value: number } | null} */ (
    await db(env)
      .prepare(`UPDATE counters SET value = value + 1 WHERE name = 'ideas' RETURNING value`)
      .bind()
      .first()
  );
  if (counter == null) throw new Error('лічильник ideas відсутній - міграція 0011 не застосована');
  const number = Number(counter.value);
  await db(env)
    .prepare(
      `INSERT INTO ideas (id, number, title, body_md, domain, status, priority, effort, next_action,
         tags_json, source_msg_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'нова', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      number,
      storedTitle,
      body,
      domain,
      priority,
      effort,
      clipShort(args.next_action),
      tags ? JSON.stringify(tags) : null,
      args.source_msg_id == null ? null : String(args.source_msg_id).slice(0, 64),
      iso,
      iso,
    )
    .run();
  // Індекс - з тим самим текстом, що й рядок (не з необрізаної назви).
  await ftsReplace(env, id, storedTitle, body);
  await logEvent(env, id, 'created', null, nowMs);
  return {
    result: {
      id,
      number,
      title: storedTitle,
      domain,
      status: 'нова',
      priority,
    },
  };
}

/**
 * ideas.update: часткова правка полів; повертає знімок ДО правки для «↩».
 * Статус звіряється зі списком; аналіз/план - лише текст (S-3-2: план пише
 * модель у тій самій сесії і кладе сюди).
 * @param {Env} env
 * @param {Record<string, unknown> & { id: unknown }} args
 * @param {number} nowMs
 */
export async function runIdeasUpdate(env, args, nowMs) {
  const idea = await findIdea(env, args.id);
  if (!idea) throw new Error(`ідеї «${String(args.id)}» немає`);
  /** @type {Record<string, unknown>} */
  const patch = {};
  for (const key of UPDATABLE) {
    if (!(key in args) || args[key] === undefined) continue;
    patch[key] = args[key];
  }
  if (Object.keys(patch).length === 0) throw new Error('нічого оновлювати - жодного відомого поля');

  if ('status' in patch && !IDEA_STATUSES.includes(String(patch.status))) {
    throw new Error(
      `невідомий status "${String(patch.status)}" (чинні: ${IDEA_STATUSES.join(', ')})`,
    );
  }
  if ('domain' in patch && !IDEA_DOMAINS.includes(String(patch.domain))) {
    throw new Error(`невідомий domain "${String(patch.domain)}"`);
  }
  if ('priority' in patch) patch.priority = normalizePriority(patch.priority);
  if ('effort' in patch) patch.effort = normalizeEffort(patch.effort);
  if ('title' in patch) {
    // null тут - не «не чіпати», а спроба стерти назву: String(null) дав би
    // ідею з назвою «null» без жодної помилки.
    const t = patch.title == null ? '' : String(patch.title).trim();
    if (!t) throw new Error('title не може бути порожнім');
    patch.title = t.slice(0, 200);
  }
  for (const k of ['body_md', 'analysis_md', 'plan_md']) {
    if (k in patch) patch[k] = clipText(patch[k]);
  }
  if ('next_action' in patch) patch.next_action = clipShort(patch.next_action);
  const tags = 'tags' in patch ? normalizeTags(patch.tags) : undefined;

  const iso = new Date(nowMs).toISOString();
  /** @type {string[]} */
  const sets = [];
  /** @type {unknown[]} */
  const binds = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'tags') continue;
    sets.push(`${k} = ?`);
    binds.push(v ?? null);
  }
  if (tags !== undefined) {
    sets.push('tags_json = ?');
    binds.push(tags ? JSON.stringify(tags) : null);
  }
  if (patch.status === 'погоджено') {
    sets.push('plan_approved_at = ?');
    binds.push(iso);
  }
  sets.push('updated_at = ?');
  binds.push(iso);
  binds.push(idea.id);
  await db(env)
    .prepare(`UPDATE ideas SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if ('title' in patch || 'body_md' in patch) {
    await ftsReplace(
      env,
      idea.id,
      String(patch.title ?? idea.title),
      'body_md' in patch ? /** @type {string | null} */ (patch.body_md) : idea.body_md,
    );
  }
  const kind =
    'status' in patch
      ? 'status'
      : 'plan_md' in patch
        ? 'plan'
        : 'analysis_md' in patch
          ? 'analysis'
          : 'edit';
  await logEvent(
    env,
    idea.id,
    kind,
    kind === 'status' ? `${idea.status} → ${String(patch.status)}` : Object.keys(patch).join(','),
    nowMs,
  );
  // Знімок ДО правки - лише ті поля, що змінились: undo повертає їх як були.
  /** @type {Record<string, unknown>} */
  const prev = {};
  const before = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (idea));
  for (const k of Object.keys(patch)) {
    prev[k] = k === 'tags' ? parseTags(idea.tags_json) : (before[k] ?? null);
  }
  return {
    result: { id: idea.id, number: idea.number, updated: Object.keys(patch) },
    prev: { id: idea.id, fields: prev },
  };
}

/**
 * ideas.list (S-3-6): ≤ 10 за domain/status, свіжі першими; без фільтрів -
 * усе, що не зроблено/відхилено.
 * @param {Env} env
 * @param {{ domain?: string, status?: string, limit?: number }} args
 */
export async function runIdeasList(env, args) {
  const where = [];
  const binds = [];
  if (args.domain != null) {
    if (!IDEA_DOMAINS.includes(args.domain)) throw new Error(`невідомий domain "${args.domain}"`);
    where.push('domain = ?');
    binds.push(args.domain);
  }
  if (args.status != null) {
    if (!IDEA_STATUSES.includes(args.status)) throw new Error(`невідомий status "${args.status}"`);
    where.push('status = ?');
    binds.push(args.status);
  } else {
    where.push(`status NOT IN ('зроблено', 'відхилено')`);
  }
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? IDEAS_LIST_MAX), 1), IDEAS_LIST_MAX);
  const { results } = await db(env)
    .prepare(
      `SELECT number, id, title, domain, status, priority, effort, next_action, updated_at
       FROM ideas WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`,
    )
    .bind(...binds)
    .all();
  return { result: results ?? [] };
}

/**
 * ideas.search: FTS5 по назві й тілу. Запит - слова у лапках (AND), щоб
 * синтаксис FTS з тексту власника не став оператором.
 * @param {Env} env
 * @param {{ q: string }} args
 */
export async function runIdeasSearch(env, args) {
  const match = ftsQuery(args.q);
  if (!match) throw new Error('q має містити хоч одне слово');
  const { results } = await db(env)
    .prepare(
      `SELECT i.number, i.id, i.title, i.domain, i.status, i.next_action, i.updated_at
       FROM ideas_fts f JOIN ideas i ON i.id = f.id
       WHERE ideas_fts MATCH ? ORDER BY rank LIMIT ${IDEAS_LIST_MAX}`,
    )
    .bind(match)
    .all();
  return { result: results ?? [] };
}

/**
 * ideas.delete (T1 через policy): рядок, події, FTS. Без «↩» - це T1.
 * @param {Env} env
 * @param {{ id: unknown }} args
 */
export async function runIdeasDelete(env, args) {
  const idea = await findIdea(env, args.id);
  if (!idea) throw new Error(`ідеї «${String(args.id)}» немає`);
  await db(env).batch([
    db(env).prepare('DELETE FROM idea_events WHERE idea_id = ?').bind(idea.id),
    db(env).prepare('DELETE FROM ideas_fts WHERE id = ?').bind(idea.id),
    db(env).prepare('DELETE FROM ideas WHERE id = ?').bind(idea.id),
  ]);
  return { result: { deleted: true, id: idea.id, number: idea.number, title: idea.title } };
}

/**
 * ideas.analyze (S-3-2): mode=plan - статус «в аналізі», ідея повертається
 * моделі, яка пише analysis_md/plan_md у тій самій сесії і кладе їх через
 * ideas.update(status='план готовий'). mode=code - етап 4.
 * @param {Env} env
 * @param {{ id: unknown, mode?: string }} args
 * @param {number} nowMs
 */
export async function runIdeasAnalyze(env, args, nowMs) {
  const mode = args.mode ?? 'plan';
  if (mode === 'code') {
    throw new Error(
      'аналіз по коду (IdeaAnalysis у GitHub Actions) приїде на етапі 4 - поки лише план (mode=plan)',
    );
  }
  if (mode !== 'plan') throw new Error(`mode лише plan|code, не "${String(mode)}"`);
  const idea = await findIdea(env, args.id);
  if (!idea) throw new Error(`ідеї «${String(args.id)}» немає`);
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(`UPDATE ideas SET status = 'в аналізі', updated_at = ? WHERE id = ?`)
    .bind(iso, idea.id)
    .run();
  await logEvent(env, idea.id, 'analysis', `plan: ${idea.status} → в аналізі`, nowMs);
  return {
    result: {
      id: idea.id,
      number: idea.number,
      title: idea.title,
      body_md: idea.body_md,
      domain: idea.domain,
      tags: parseTags(idea.tags_json),
      instruction:
        'Напиши аналіз (analysis_md: контекст, ризики, альтернативи) і план (plan_md: кроки з оцінкою S/M/L), ' +
        'збережи їх через ideas.update(id, analysis_md, plan_md, status="план готовий", effort). ' +
        'Відповідь власнику - до 3 500 символів або документом.',
    },
    prev: { id: idea.id, status: idea.status },
  };
}

// ── Внутрішнє ──────────────────────────────────────────────────────────────

/** @param {Env} env @param {string} id @param {string} title @param {string | null} body */
async function ftsReplace(env, id, title, body) {
  await db(env).batch([
    db(env).prepare('DELETE FROM ideas_fts WHERE id = ?').bind(id),
    db(env)
      .prepare('INSERT INTO ideas_fts (id, title, body_md) VALUES (?, ?, ?)')
      .bind(id, title, body ?? ''),
  ]);
}

/** @param {Env} env @param {string} ideaId @param {string} kind @param {string | null} note @param {number} nowMs */
async function logEvent(env, ideaId, kind, note, nowMs) {
  await db(env)
    .prepare('INSERT INTO idea_events (id, idea_id, at, kind, note) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ideaId, new Date(nowMs).toISOString(), kind, note)
    .run();
}

/**
 * Запит FTS5: кожне слово - у подвійних лапках (внутрішні лапки подвоєні),
 * зʼєднані пробілом (AND). Оператори FTS (AND, OR, NOT, NEAR, зірочка,
 * каретка) з тексту власника так стають літералами.
 * @param {unknown} raw
 */
export function ftsQuery(raw) {
  const words = String(raw ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/"/g, '').trim())
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.map((w) => `"${w}"`).join(' ');
}

/** @param {unknown} v */
function normalizePriority(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error('priority - ціле 1-3');
  return n;
}

/** @param {unknown} v */
function normalizeEffort(v) {
  if (v == null || v === '') return null;
  if (!IDEA_EFFORTS.includes(String(v))) throw new Error('effort лише S|M|L');
  return String(v);
}

/** @param {unknown} v @returns {string[] | null} */
function normalizeTags(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new Error('tags - список рядків');
  const tags = v.map((t) => String(t).trim().slice(0, 32)).filter(Boolean);
  return tags.length ? tags.slice(0, 12) : null;
}

/** @param {string | null} raw @returns {string[] | null} */
function parseTags(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/** @param {unknown} v */
function clipText(v) {
  if (v == null) return null;
  const s = String(v);
  return s.length > IDEA_TEXT_MAX ? s.slice(0, IDEA_TEXT_MAX) : s;
}

/** @param {unknown} v */
function clipShort(v) {
  if (v == null) return null;
  return String(v).slice(0, 300);
}
