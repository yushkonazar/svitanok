// Stateful tutoring is owned by the core, not the model's conversational
// memory. A question, answer and review are persisted and addressed by id.

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/** @param {string} text */
export function tutorQuestion(text) {
  const source = String(text ?? '').trim();
  const first = source.match(/^🎓\s*([^\n]{1,100})\n/u);
  if (!first || !/Можеш відповісти або попросити підказку\.?\s*$/iu.test(source)) return null;
  if (source.length > 3_500) return null;
  return { topic: String(first[1]).trim(), question: source };
}

/** @param {string} id @param {'question'|'awaiting_answer'|'reviewed'} status */
export function tutorButtons(id, status) {
  if (status === 'reviewed')
    return [
      [
        { text: '🙂 Було легко', callback_data: `m:tu:${id}:easy` },
        { text: '🧩 Було складно', callback_data: `m:tu:${id}:hard` },
      ],
      [{ text: '⏹ Завершити', callback_data: `m:tu:${id}:finish` }],
    ];
  if (status === 'awaiting_answer')
    return [
      [{ text: '↩ Скасувати відповідь', callback_data: `m:tu:${id}:cancel` }],
      [{ text: '⏹ Завершити', callback_data: `m:tu:${id}:finish` }],
    ];
  return [
    [
      { text: '💡 Підказка', callback_data: `m:tu:${id}:hint` },
      { text: '🧪 Приклад', callback_data: `m:tu:${id}:example` },
    ],
    [
      { text: '✍️ Відповісти', callback_data: `m:tu:${id}:answer` },
      { text: '⏭ Пропустити', callback_data: `m:tu:${id}:skip` },
    ],
    [{ text: '⏹ Завершити', callback_data: `m:tu:${id}:finish` }],
  ];
}

/** @typedef {{ id: string, thread_id: string, chat_id: string, topic: string,
 * question_text: string, answer_text: string|null, review_text: string|null,
 * status: string, rating: string|null, due_at: string|null }} TutorSession */

/** @param {Env} env @param {string} id @returns {Promise<TutorSession|null>} */
export async function readTutorSession(env, id) {
  return /** @type {TutorSession|null} */ (
    await db(env)
      .prepare(
        'SELECT id, thread_id, chat_id, topic, question_text, answer_text, review_text, status, rating, due_at FROM learning_sessions WHERE id = ?',
      )
      .bind(id)
      .first()
  );
}

/** @param {Env} env @param {string} threadId @param {string} chatId
 * @param {string[]} statuses @returns {Promise<TutorSession|null>} */
async function latestTutorSession(env, threadId, chatId, statuses) {
  if (!statuses.length) return null;
  const placeholders = statuses.map(() => '?').join(', ');
  return /** @type {TutorSession|null} */ (
    await db(env)
      .prepare(
        `SELECT id, thread_id, chat_id, topic, question_text, answer_text, review_text, status, rating, due_at FROM learning_sessions WHERE thread_id = ? AND chat_id = ? AND status IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(threadId, chatId, ...statuses)
      .first()
  );
}

/** @param {Env} env @param {string} threadId @param {string} chatId */
export function awaitingTutorAnswer(env, threadId, chatId) {
  return latestTutorSession(env, threadId, chatId, ['awaiting_answer']);
}

/** Save a new question or attach a tutor hint/review to the current session.
 * @param {Env} env @param {{ id: string, text: string, threadId: string,
 * chatId: string, nowMs: number }} input */
export async function saveTutorWorkerResult(env, input) {
  const question = tutorQuestion(input.text);
  const now = new Date(input.nowMs).toISOString();
  if (question) {
    // D1 batch is transactional: a failed insert must not erase the previous
    // active question. The new id is excluded from the supersede step.
    await db(env).batch([
      db(env)
        .prepare(
          "INSERT INTO learning_sessions (id, thread_id, chat_id, topic, question_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'question', ?, ?)",
        )
        .bind(input.id, input.threadId, input.chatId, question.topic, question.question, now, now),
      db(env)
        .prepare(
          "UPDATE learning_sessions SET status = 'superseded', updated_at = ? WHERE thread_id = ? AND chat_id = ? AND id != ? AND status IN ('question', 'awaiting_answer', 'answer_submitted', 'reviewed')",
        )
        .bind(now, input.threadId, input.chatId, input.id),
    ]);
    return readTutorSession(env, input.id);
  }
  const active = await latestTutorSession(env, input.threadId, input.chatId, [
    'answer_submitted',
    'question',
  ]);
  if (!active) return null;
  if (active.status === 'answer_submitted') {
    // A hint requested just before the answer may finish first. Only the
    // tutor's review format may close the answer; a late hint must not become
    // a false review with difficulty buttons.
    if (!/(?:^|\n)(?:Є в рішенні:|Потрібно уточнити:|Один робочий варіант:)/u.test(input.text))
      return null;
    await db(env)
      .prepare(
        "UPDATE learning_sessions SET review_text = ?, status = 'reviewed', updated_at = ? WHERE id = ? AND status = 'answer_submitted'",
      )
      .bind(input.text.slice(0, 7_500), now, active.id)
      .run();
    return readTutorSession(env, active.id);
  }
  return active.status === 'question' ? active : null;
}

/** @param {Env} env @param {string} id @param {string} chatId @param {string} threadId
 * @param {'question'|'awaiting_answer'|'answer_submitted'|'reviewed'} from
 * @param {string} to @param {number} nowMs */
export async function changeTutorStatus(env, id, chatId, threadId, from, to, nowMs) {
  const result = await db(env)
    .prepare(
      'UPDATE learning_sessions SET status = ?, updated_at = ? WHERE id = ? AND chat_id = ? AND thread_id = ? AND status = ?',
    )
    .bind(to, new Date(nowMs).toISOString(), id, chatId, threadId, from)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** @param {Env} env @param {TutorSession} session @param {string} answer @param {number} nowMs */
export async function submitTutorAnswer(env, session, answer, nowMs) {
  const result = await db(env)
    .prepare(
      "UPDATE learning_sessions SET answer_text = ?, status = 'answer_submitted', updated_at = ? WHERE id = ? AND status = 'awaiting_answer'",
    )
    .bind(answer.slice(0, 3_500), new Date(nowMs).toISOString(), session.id)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** @param {TutorSession} session @param {string} answer */
export function tutorAnswerFollowup(session, answer) {
  return [
    'Розбери відповідь власника на збережене навчальне питання. Делегуй працівнику tutor, передавши йому питання та відповідь разом.',
    `Питання ${session.id}: ${JSON.stringify(session.question_text)}`,
    `Відповідь власника: ${JSON.stringify(answer)}`,
    'Оціни розвʼязок за змістом, не за буквальним збігом із одним прикладом. Не записуй easy/hard: власник окремо оцінить складність.',
  ].join('\n\n');
}

/** @param {Env} env @param {TutorSession} session @param {'easy'|'hard'} rating
 * @param {number} nowMs */
export async function rateTutorSession(env, session, rating, nowMs) {
  // Deliberate, simple starting policy: owner-rated hard -> tomorrow; easy ->
  // in seven days. This is a review suggestion, not a correctness score.
  const due = new Date(nowMs + (rating === 'hard' ? 1 : 7) * 86_400_000).toISOString();
  const result = await db(env)
    .prepare(
      "UPDATE learning_sessions SET rating = ?, due_at = ?, status = 'rated', updated_at = ? WHERE id = ? AND status = 'reviewed'",
    )
    .bind(rating, due, new Date(nowMs).toISOString(), session.id)
    .run();
  return Number(result.meta?.changes ?? 0) === 1 ? due : null;
}
