// Корпус стилю власника (релізний блок PR-8, §6 варіант A).
//
// ІДЕЯ. Своєї моделі ми не тренуємо - це дорого, повільно й дає гіршу мову,
// ніж чужа модель із гарними прикладами. Замість цього беремо ВЛАСНІ тексти
// власника й показуємо їх Копірайтеру та Редактору як зразок голосу. Шар
// поверх чужої моделі, а не своя модель.
//
// ⚠️ ЗВІДКИ ТЕКСТИ. Лише те, що написав САМ власник: його вихідні
// повідомлення з `inbox_messages` (from_id = TELEGRAM_OWNER_USER_ID). Чужі
// повідомлення не беруться ніколи - інакше «його голосом» писалося б чуже, а
// в корпус потрапляв би зовнішній вміст, який потім ішов би в чужий сервіс
// (модель) без жодної позначки.
//
// ⚠️ ЗБІР - ДІЯ T1. Це рішення канону (07 §1, `style_corpus`): корпус свого
// голосу власник дає СВІДОМО, а не збирається сам собою фоном.

const OWN_MIN_CHARS = 60;
const OWN_MAX_CHARS = 600;
/** Скільки зразків тримаємо в корпусі всього. */
export const CORPUS_CAP = 200;
/** Скільки зразків іде працівнику: більше - це вже переказ корпусу, не зразок. */
export const SAMPLES_DEFAULT = 12;
export const SAMPLES_MAX = 30;
/** Скільки INSERT-ів в одному batch: із запасом під ~50 підзапитів Worker'а. */
const BATCH_SIZE = 50;

/** @template T @param {T[]} arr @param {number} size @returns {T[][]} */
function chunks(arr, size) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * Зібрати власні тексти в корпус. Ідемпотентно: той самий текст удруге не
 * лягає (ключ рядка - хеш тексту, а не id повідомлення: те саме власник міг
 * написати в двох чатах, і як зразок голосу воно одне).
 * @param {Env} env
 * @param {number} nowMs
 * @returns {Promise<{ result: { added: number, total: number, scanned: number,
 *   error?: string } }>}
 */
export async function collectOwnStyle(env, nowMs) {
  const owner = String(env.TELEGRAM_OWNER_USER_ID ?? '').trim();
  if (!owner) throw new Error('стиль: TELEGRAM_OWNER_USER_ID не заданий - нема кого впізнавати');
  const { results } = await db(env)
    .prepare(
      `SELECT id, text, at FROM inbox_messages
       WHERE from_id = ? AND text IS NOT NULL
         AND length(text) BETWEEN ? AND ?
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(owner, OWN_MIN_CHARS, OWN_MAX_CHARS, CORPUS_CAP)
    .all();
  const rows = /** @type {{ id: string, text: string, at: string }[]} */ (results ?? []);

  // ⚠️ BATCH, не цикл із await (ревʼю релізу): запит до D1 - це підзапит
  // Worker'а, а їх на виклик ~50. Двісті окремих INSERT-ів валили б КОЖЕН
  // збір приблизно на пʼятдесятому рядку, лишаючи корпус наполовину
  // записаним. batch() відправляє їх одним запитом.
  const insert = db(env).prepare(
    `INSERT INTO style_corpus (id, msg_id, at, text, kind, approved)
     VALUES (?, ?, ?, ?, 'message', 1)
     ON CONFLICT (id) DO NOTHING`,
  );
  /** @type {ReturnType<typeof insert.bind>[]} */
  const stmts = [];
  for (const r of rows) {
    const text = String(r.text ?? '').trim();
    if (!text) continue;
    stmts.push(insert.bind(await textKey(text), r.id, r.at ?? new Date(nowMs).toISOString(), text));
  }
  let added = 0;
  /** @type {string | null} */
  let broke = null;
  for (const chunk of chunks(stmts, BATCH_SIZE)) {
    try {
      const res = await db(env).batch(chunk);
      added += res.reduce((n, one) => n + (one.meta?.changes ?? 0), 0);
    } catch (/** @type {any} */ e) {
      // ⚠️ Двісті рядків - це кілька batch-ів, і збій третього не сміє
      // викинути те, що вже записали перші два (другий прохід ревʼю).
      // Кажемо, скільки встигли, і НАЗИВАЄМО збій - мовчазний «ок» тут
      // виглядав би як повний корпус.
      broke = String(e?.message ?? e);
      console.error('стиль: пачка не записалась', broke);
      break;
    }
  }
  await trimCorpus(env);
  const total = await corpusSize(env);
  // `added` рахує вставлене ДО чистки: стеля могла зрізати частину як
  // найстаріше. Тому в результаті є й `total` - скільки лишилось насправді.
  return { result: { added, total, scanned: rows.length, ...(broke ? { error: broke } : {}) } };
}

/**
 * Зразки голосу для працівника. Найсвіжіші: голос змінюється, і рік тому
 * власник писав інакше.
 * @param {Env} env
 * @param {{ limit?: unknown }} [args]
 * @returns {Promise<{ result: { samples: string[], total: number } }>}
 */
export async function runStyleSamples(env, args = {}) {
  const asked = Number(args.limit);
  const limit =
    Number.isInteger(asked) && asked > 0 ? Math.min(asked, SAMPLES_MAX) : SAMPLES_DEFAULT;
  const { results } = await db(env)
    .prepare(
      `SELECT text FROM style_corpus WHERE approved = 1 AND text IS NOT NULL
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  const samples = (results ?? []).map((/** @type {any} */ r) => String(r.text));
  return { result: { samples, total: await corpusSize(env) } };
}

/**
 * Блок для `task` працівника. Порожній корпус - порожній рядок, а не
 * заглушка: працівник має відрізняти «зразків немає» від «ось нуль зразків».
 * @param {string[]} samples
 */
export function styleBlock(samples) {
  if (samples.length === 0) return '';
  return [
    'Приклади голосу власника (його власні тексти, не переказувати й не цитувати - лише наслідувати манеру):',
    ...samples.map((s) => `— ${s.replace(/\s+/g, ' ').trim()}`),
  ].join(String.fromCharCode(10));
}

/** Розмір корпусу - і для звіту власнику, і щоб не вгадувати. @param {Env} env */
async function corpusSize(env) {
  const row = /** @type {any} */ (
    await db(env).prepare('SELECT COUNT(*) AS n FROM style_corpus').bind().first()
  );
  return Number(row?.n) || 0;
}

/** Стеля корпусу: найстаріші зайві - геть. @param {Env} env */
async function trimCorpus(env) {
  await db(env)
    .prepare(
      `DELETE FROM style_corpus WHERE id IN (
         SELECT id FROM style_corpus ORDER BY at DESC LIMIT -1 OFFSET ?
       )`,
    )
    .bind(CORPUS_CAP)
    .run();
}

/** Ключ рядка - хеш тексту: той самий текст двічі в корпусі не потрібен.
 *  @param {string} text */
async function textKey(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
