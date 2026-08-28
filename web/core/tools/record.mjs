// record (07-schema §4): один інструмент - чотири види локальних записів у
// чинні KV-сховища: чек-ін, голос за новину, стадія вакансії, роадмеп.
// Рівень T0 (власні дані, не назовні); у tainted policy підіймає до T1.
//
// ⚠️ ЖОДНОЇ ВЛАСНОЇ ЛОГІКИ ЗАПИСУ. Кожен вид проходить тим самим примітивом,
// що й дашборд із легасі-агентом: applyEvent (чек-ін, стадія вакансії),
// applyUrlVote + recordEvent (голос), toggleProgress (роадмеп). Друга
// реалізація тут означала б, що Mini App і асистент рахують стрік по-різному.

import { applyEvent } from '../../api-dashboard.mjs';
import { loadState, loadStats, updateState, updateStats } from '../../kv-store.mjs';
import { aggregateStats, recordEvent, checkinSlot } from '../../stats-core.mjs';
import { toggleProgress, progressKey } from '../../roadmap-core.mjs';
import { applyUrlVote } from '../../prefs-core.mjs';
import { loadLatest } from '../../kv-store.mjs';
import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';

/** Види записів - дослівно 07 §4. */
export const RECORD_KINDS = ['checkin', 'news-vote', 'job-stage', 'roadmap'];

/** Стадії воронки, які модель може ставити (термінальні - теж рішення власника). */
const JOB_STAGES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'failed'];

/** Скільки позицій показує data.read (MAX_LIST_ITEMS у assistant-data-core):
 *  голосувати й міняти стадію можна лише в межах побаченого. */
const NEWS_LIST_CAP = 8;

/**
 * record: {kind, payload} → запис у чинне сховище.
 * Повертає {result} з тим, що САМЕ записано - модель переказує це власнику, і
 * вигадати «записав» без запису вона не може.
 * @param {Env} env
 * @param {{ kind: string, payload?: Record<string, any> }} args
 * @param {number} nowMs
 */
export async function runRecord(env, args, nowMs) {
  if (!RECORD_KINDS.includes(args.kind)) {
    throw new Error(`невідомий kind "${args.kind}" - лише ${RECORD_KINDS.join('·')}`);
  }
  const payload = args.payload ?? {};
  const now = new Date(nowMs);

  if (args.kind === 'checkin') return recordCheckin(env, payload, now);
  if (args.kind === 'news-vote') return recordNewsVote(env, payload, now);
  if (args.kind === 'job-stage') return recordJobStage(env, payload, now);
  return recordRoadmap(env, payload, now);
}

/** Чек-ін: слот рахує КОД за київською годиною - модель його не задає.
 *  @param {Env} env @param {Record<string, any>} payload @param {Date} now */
async function recordCheckin(env, payload, now) {
  const slot = checkinSlot(kyivHour(now));
  if (!slot) throw new Error('зараз тиха зона (02:00-08:00) - чек-ін не пишемо');
  // ⚠️ `type` ОСТАННІЙ і поверх payload (security-ревʼю PR-6): при
  // `{ type: 'checkin', ...payload }` ключ `type` усередині payload перекривав
  // би свій же літерал, і виклик «запиши чек-ін» писав би job_stage з
  // довільним url - повз RECORD_KINDS, перелік стадій і привʼязку до воронки
  // власника, ще й зі звітом «записав чек-ін».
  const result = await applyEvent(env, { ...payload, type: 'checkin' });
  if (result?.locked) {
    // Уже підтверджений блок - НЕ помилка інструмента, але й не запис:
    // модель мусить сказати власнику правду, а не «записав».
    return { result: { kind: 'checkin', slot, written: false, reason: 'slot-locked' } };
  }
  return { result: { kind: 'checkin', slot, written: true } };
}

/** Голос за новину: індекс із того самого списку, що бачить власник у /save.
 *  @param {Env} env @param {Record<string, any>} payload @param {Date} now */
async function recordNewsVote(env, payload, now) {
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 1) throw new Error('index - позиція новини від 1');
  const latest = await loadLatest(env);
  const groups = latest?.blocks?.find((/** @type {any} */ b) => b?.id === 'news')?.data?.groups;
  const flat = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const it of Array.isArray(g?.items) ? g.items : []) {
      flat.push({ url: it?.url, topic: g.topic, title: it?.title });
      // Та сама стеля, що в digestNews (assistant-data-core): модель голосує
      // рівно за те, що бачила у списку. Без неї індекс 9+ ставив би вподобання
      // новині, якої в її контексті не було (ревʼю PR-6).
      if (flat.length >= NEWS_LIST_CAP) break;
    }
    if (flat.length >= NEWS_LIST_CAP) break;
  }
  const item = flat[index - 1];
  if (!item?.url) throw new Error(`новини №${index} немає у свіжому брифінгу - перечитай список`);

  // `r` заповнює сам patch: при розбіжності updateState викликає його вдруге,
  // і потрібна дельта ТІЄЇ копії, яку зрештою записали (та сама пастка, що в
  // легасі-шляху agent-runtime).
  /** @type {any} */
  let r;
  await updateState(env, (s) => {
    r = applyUrlVote(s.preferenceWeights ?? {}, s.votedUrls ?? {}, item.url, item.topic, 'up');
    return { ...s, preferenceWeights: r.weights, votedUrls: r.votedUrls };
  });
  const dateKey = kyivDateKey(now);
  await updateStats(env, (cur) =>
    recordEvent(
      cur,
      {
        type: 'vote',
        category: item.topic,
        dir: r.newDir,
        prevDir: r.prevDir,
        prevCategory: r.prevCategory,
      },
      dateKey,
    ),
  );
  return { result: { kind: 'news-vote', title: item.title ?? null, topic: item.topic ?? null } };
}

/** Стадія вакансії: індекс із живої воронки (той самий funnelList, що в /jobs).
 *  @param {Env} env @param {Record<string, any>} payload @param {Date} now */
async function recordJobStage(env, payload, now) {
  const index = Number(payload.index);
  const stage = String(payload.stage ?? '');
  if (!Number.isInteger(index) || index < 1) throw new Error('index - позиція вакансії від 1');
  if (!JOB_STAGES.includes(stage)) {
    throw new Error(`невідома стадія "${stage}" - лише ${JOB_STAGES.join('·')}`);
  }
  const agg = aggregateStats(await loadStats(env), kyivDateKey(now));
  const item = (agg.funnelList ?? []).slice(0, NEWS_LIST_CAP)[index - 1];
  if (!item?.url) throw new Error(`вакансії №${index} немає у воронці - перечитай список`);
  await applyEvent(env, { type: 'job_stage', url: item.url, stage, title: item.title });
  return { result: { kind: 'job-stage', title: item.title || item.url, stage } };
}

/** Роадмеп: позначити підтему вивченою (ідемпотентно).
 *  @param {Env} env @param {Record<string, any>} payload @param {Date} now */
async function recordRoadmap(env, payload, now) {
  const topicId = String(payload.topic_id ?? '');
  const subtopicId = String(payload.subtopic_id ?? '');
  if (!topicId || !subtopicId) throw new Error('потрібні topic_id і subtopic_id');
  const key = progressKey(topicId, subtopicId);
  const state = await loadState(env);
  if (state.roadmapProgress?.[key]) {
    return { result: { kind: 'roadmap', key, written: false, reason: 'already-done' } };
  }
  const doneAt = now.toISOString();
  await updateState(env, (s) => {
    // toggleProgress - ПЕРЕМИКАЧ: на свіжішій копії, де прапорець уже стоїть
    // (власник устиг тапнути те саме в Mini App), повторний виклик зняв би його.
    const progress = s.roadmapProgress ?? {};
    if (progress[key]) return s;
    return { ...s, roadmapProgress: toggleProgress(progress, topicId, subtopicId, doneAt) };
  });
  return { result: { kind: 'roadmap', key, written: true } };
}
