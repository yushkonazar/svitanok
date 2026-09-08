// Пропозиції (07-schema §1 `proposals`) і виконання рішень власника - єдине
// місце, що викликає виконавців запису (01 §2.1 policy). Життєвий цикл:
// open → approved | rejected | expired; рішення ідемпотентне (другий тап по
// тій самій кнопці нічого не переграє). T0-виконання лишає undo-рядок
// (kind `undo:<kind>`, TTL 10 хв) - «↩» відкочує через executor.undo.
//
// Виконавці - реєстр EXECUTORS: зараз лише facts.set (єдиний write-інструмент
// етапу 1); календар/контакти/drive підключать адаптери етапу 2. Прийняте ✅
// без виконавця - ЯВНА відмова no-executor, не тихе «прийнято і забуто».

import {
  decideLevel,
  pickT2Word,
  proposalButtons,
  undoButton,
  sanitizeGeminiPayload,
  PROPOSAL_TTL_MS,
  UNDO_WINDOW_MS,
} from './core.mjs';
import { runFactsSet, runFactsGet, FACT_KINDS } from '../tools/facts.mjs';
import { runRecord } from '../tools/record.mjs';
import {
  runRemindersCreate,
  runRemindersUpdate,
  runRemindersCancel,
  readActiveReminders,
} from '../tools/reminders.mjs';
import { restoreReminder } from '../reminders/store.mjs';
import { plural } from '../tg/phrase.mjs';
import {
  runIdeasCreate,
  runIdeasUpdate,
  runIdeasDelete,
  runIdeasAnalyze,
} from '../tools/ideas.mjs';
import { cancelAnalysis, restoreIdeaRepo } from '../ideas/analysis.mjs';
import { startTableChain, cancelTableChain, findActiveTableChain } from '../chains/table.mjs';
import { startTripChain, cancelTripChain } from '../chains/trip.mjs';
import { importSteamWishlist } from '../steam/check.mjs';
import {
  startPriceTrack,
  cancelPriceTrack,
  cancelPriceChain,
  findActivePriceChain,
  trackingText,
} from '../chains/price.mjs';
import {
  runWishesCreate,
  runWishesUpdate,
  runWishesDelete,
  restoreWish,
  deleteWishRow,
  findWish,
} from '../tools/wishes.mjs';
import { runFinanceRule, restoreRule } from '../tools/finance.mjs';
import { forgetChat } from '../inbox/store.mjs';
import { runDataExport } from '../export/data-export.mjs';
import { forgetAll } from '../export/forget-all.mjs';
import { updateSubscription } from '../finance/subscriptions.mjs';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  createContact,
  resolveAttendees,
  assertGoogleScope,
} from '../../google.mjs';
import { createTask } from '../adapters/tasks.mjs';
import {
  generateImage,
  generateVideo,
  videoUsd,
  IMAGE_USD,
  VIDEO_DEFAULT_SECONDS,
  VIDEO_MAX_SECONDS,
} from '../adapters/gemini.mjs';
import { bumpQuota, quotaLimitOf, quotaUsed } from '../quota/quota.mjs';
import { sendMediaBytes } from '../tg/media.mjs';
import { ensureFolderPath, uploadCsvAsSheet, uploadFile } from '../adapters/drive.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { normalizeSettings } from '../../settings-core.mjs';
import {
  runCollectionsCreate,
  runCollectionsUpdate,
  restoreCollection,
  deleteCollection,
  runRecordsCreate,
  runRecordsUpdate,
  runRecordsDelete,
  restoreRecord,
  exportCollectionCsv,
} from '../tools/collections.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import {
  runPlanIntent,
  runPlanDraft,
  runPlanAccept,
  undoPlanAccept,
  runPlanUpdate,
  undoPlanUpdate,
  runPlanReview,
} from '../tools/plan.mjs';

/** Тека експортів у Drive (S-0-6, S-N4-4): одна на всі види вивантажень. */
export const EXPORT_FOLDER_PATH = ['Світанок', 'export'];
/** Тека нотаток (S-8-3). */
export const DRIVE_NOTES_PATH = ['Світанок', 'нотатки'];
/** Стеля нотатки: більше - це вже документ працівника, у нього свій шлях. */
export const DRIVE_NOTE_MAX_CHARS = 100_000;

/**
 * Імʼя файла нотатки: назва приходить від моделі й іде в метадані Drive, тож
 * роздільники шляху й керівні символи знімаються тут. Розширення .md - щоб
 * файл відкривався як текст, а не тягнув здогад із вмісту.
 * @param {unknown} raw
 */
function driveNoteName(raw) {
  const base = String(raw ?? '')
    // Керівні й форматні символи (зокрема bidi-override) - геть: назву пише
    // модель, а файл із ними в Drive читається не так, як виглядає.
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!base) throw new Error('drive.write: потрібна назва нотатки');
  return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${base}.md`;
}

/** @typedef {{ id: string, level: string, kind: string, payload_json: string, thread_id: string | null, msg_id: number | null, word: string | null, expires_at: string, status: string, created_at: string, decided_at: string | null }} ProposalRow */

/**
 * Виконавці записів. execute повертає {prev} - знімок для undo (undefined =
 * відкочувати нічого, undo-кнопки не буде). undo приймає той знімок.
 * @type {Record<string, {
 *   execute: (env: Env, payload: any, nowMs: number,
 *     ctx?: { chatId?: number | string | null, threadId?: number | string | null })
 *     => Promise<{ prev?: unknown, result?: unknown }>,
 *   undo?: (env: Env, prev: any, nowMs: number) => Promise<void>,
 * }>}
 */
export const EXECUTORS = {
  // Нагадування (PR-6). undo вертає ТОЙ САМИЙ id: власник бачить у списку той
  // самий рядок, що й до «↩», а не новий - інакше друге «↩» після ручної
  // правки скасувало б чуже нагадування.
  'reminders.create': {
    async execute(env, payload, nowMs, ctx) {
      // ⚠️ ЛИШЕ відомі поля (security-ревʼю PR-6): payload приходить із
      // proposals.create без схеми, тож передавати його виконавцю as-is
      // означало б дати моделі доступ і до внутрішніх полів, і до адреси
      // доставки. Адресу бере ядро з контексту прогону.
      const { result } = await runRemindersCreate(
        env,
        { text: payload.text, when: payload.when },
        nowMs,
        { chatId: ctx?.chatId, threadId: ctx?.threadId },
      );
      return { prev: { id: result.id }, result };
    },
    async undo(env, snapshot) {
      // Без .catch: нагадування могло вже спрацювати, і тоді відкоту немає -
      // краще чесна помилка, ніж тост «Відкочено ↩» при нульовій дії.
      await runRemindersCancel(env, { id: snapshot.id });
    },
  },
  'reminders.update': {
    async execute(env, payload, nowMs) {
      const before = (await readActiveReminders(env)).find((r) => r.id === payload.id);
      const { result } = await runRemindersUpdate(
        env,
        { id: payload.id, text: payload.text, when: payload.when },
        nowMs,
      );
      // Знімок ДО правки: undo кладе назад і текст, і час.
      return {
        prev: before ? { id: before.id, text: before.text, dueAt: before.dueAt } : null,
        result,
      };
    },
    async undo(env, snapshot, nowMs) {
      if (!snapshot) return;
      await runRemindersUpdate(env, { id: snapshot.id, text: snapshot.text }, nowMs, {
        dueAtMs: Date.parse(snapshot.dueAt),
      });
    },
  },
  'reminders.cancel': {
    // nowMs не потрібен: скасування не рахує часу, лише прибирає рядок.
    async execute(env, payload) {
      const before = (await readActiveReminders(env)).find((r) => r.id === payload.id);
      const { result } = await runRemindersCancel(env, { id: payload.id });
      return { prev: before ?? null, result };
    },
    async undo(env, snapshot) {
      if (!snapshot) return;
      // Рядок нікуди не зник - у D1 він лежить зі статусом cancelled, тож
      // «↩» просто повертає його в гру: id, текст, час і адреса ті самі, і
      // жодного шансу створити дубль.
      const restored = await restoreReminder(env, snapshot.id);
      if (!restored) {
        // Рядок уже не cancelled (власник устиг створити знову або статус
        // змінили): мовчазний «успіх» тут показав би тост «Відкочено ↩» після
        // нульової дії (ревʼю PR-7).
        throw new Error(`нагадування ${snapshot.id} не відновлено - воно вже не скасоване`);
      }
    },
  },
  // record: БЕЗ undo. Чинні модулі (applyEvent, recordEvent, toggleProgress)
  // зворотної операції не мають - стрік, ваги преференцій і воронка
  // перераховуються з подій, і «відкат» тут означав би писати компенсаційну
  // подію, тобто брехати історії. Кнопки «↩» не буде: прогін віддає prev
  // undefined (policy тоді її не показує).
  record: {
    async execute(env, payload, nowMs) {
      // kind і payload дії - і нічого більше: обгортка з proposals.create не
      // має підсовувати виконавцю зайвих полів.
      const { result } = await runRecord(
        env,
        { kind: payload.kind, payload: payload.payload },
        nowMs,
      );
      return { result };
    },
  },
  // Ідеї (етап 3 PR-4): create/update/analyze - T0 з «↩», delete - T1 без
  // відкату (видалення одного запису - 01 §4.3). Виконавці передають лише
  // відомі поля - схема інструмента вже їх звузила, а payload пропозиції ні.
  'ideas.create': {
    async execute(env, payload, nowMs) {
      const { result } = await runIdeasCreate(
        env,
        {
          title: payload.title,
          body_md: payload.body_md,
          domain: payload.domain,
          priority: payload.priority,
          effort: payload.effort,
          tags: payload.tags,
          next_action: payload.next_action,
        },
        nowMs,
      );
      return { prev: { id: result.id }, result };
    },
    async undo(env, snapshot) {
      // «↩» на створення - видалити щойно записану ідею разом із подіями.
      await runIdeasDelete(env, { id: snapshot.id });
    },
  },
  'ideas.update': {
    async execute(env, payload, nowMs) {
      const { result, prev } = await runIdeasUpdate(env, payload, nowMs);
      return { prev, result };
    },
    async undo(env, snapshot, nowMs) {
      // Повернути ЛИШЕ ті поля, що правились, як були до правки.
      await runIdeasUpdate(env, { id: snapshot.id, ...snapshot.fields }, nowMs);
    },
  },
  'ideas.analyze': {
    // ctx - тред запиту: документ кешованого аналізу (mode=code) іде туди.
    async execute(env, payload, nowMs, ctx) {
      const { result, prev } = await runIdeasAnalyze(
        env,
        { id: payload.id, mode: payload.mode, repo: payload.repo, force: payload.force },
        nowMs,
        { chatId: ctx?.chatId, threadId: ctx?.threadId },
      );
      return { prev, result };
    },
    async undo(env, snapshot, nowMs) {
      await runIdeasUpdate(env, { id: snapshot.id, status: snapshot.status }, nowMs);
      // Аналіз по коду вже диспатчено: ланцюг позначається cancelled, і його
      // результат буде відкинуто мовчки (Actions не зупиняємо - 40 хв стелі).
      if (snapshot.chain_id) {
        await cancelAnalysis(env, snapshot.chain_id);
        await restoreIdeaRepo(env, snapshot.id, snapshot.repo ?? null);
      }
    },
  },
  'ideas.delete': {
    async execute(env, payload) {
      const { result } = await runIdeasDelete(env, { id: payload.id });
      return { result };
    },
  },
  // Колекції (етап 3 PR-5). create/update - T0 з «↩» (create ↔ видалення
  // порожньої колекції, update ↔ попередній рядок цілком); записи - T0 з
  // «↩» (create ↔ delete, update ↔ попередній data_json); records.delete -
  // T1; forget (T2, зі словом) - колекція з усіма записами; collection.export
  // (T1) - .csv документом у чат прогону.
  'collections.create': {
    async execute(env, payload, nowMs) {
      const { result } = await runCollectionsCreate(
        env,
        {
          name: payload.name,
          description: payload.description,
          fields: payload.fields,
          sort_by: payload.sort_by,
        },
        nowMs,
      );
      return { prev: { id: result.id }, result };
    },
    async undo(env, snapshot) {
      await deleteCollection(env, snapshot.id);
    },
  },
  'collections.update': {
    async execute(env, payload) {
      const { result, prev } = await runCollectionsUpdate(env, payload);
      return { prev, result };
    },
    async undo(env, snapshot) {
      await restoreCollection(env, snapshot);
    },
  },
  'records.create': {
    async execute(env, payload, nowMs) {
      const { result } = await runRecordsCreate(
        env,
        { collection: payload.collection, data: payload.data },
        nowMs,
      );
      return { prev: { collection: result.collection, id: result.id }, result };
    },
    async undo(env, snapshot) {
      await runRecordsDelete(env, { collection: snapshot.collection, id: snapshot.id });
    },
  },
  'records.update': {
    async execute(env, payload, nowMs) {
      const { result, prev } = await runRecordsUpdate(
        env,
        { collection: payload.collection, id: payload.id, data: payload.data },
        nowMs,
      );
      return { prev, result };
    },
    async undo(env, snapshot, nowMs) {
      await restoreRecord(env, snapshot, nowMs);
    },
  },
  'records.delete': {
    async execute(env, payload) {
      const { result } = await runRecordsDelete(env, {
        collection: payload.collection,
        id: payload.id,
      });
      return { result };
    },
  },
  // План дня v2 (етап 3 PR-8, 07 §4 plan.*): усі T0. «↩» лише для accept
  // (скасувати нагадування, статус назад у draft) і update (попередні стани
  // пунктів); intent/draft перераховують чернетку - відкат безглуздий, бо
  // наступний intent її і так замінює; review - читання + перенос без undo.
  'plan.intent': {
    async execute(env, payload, nowMs) {
      const { result } = await runPlanIntent(
        env,
        { date: payload.date, items: payload.items },
        nowMs,
      );
      return { result };
    },
  },
  'plan.draft': {
    async execute(env, payload, nowMs) {
      const { result } = await runPlanDraft(env, { date: payload.date }, nowMs);
      return { result };
    },
  },
  'plan.accept': {
    async execute(env, payload, nowMs, ctx) {
      const { result, prev } = await runPlanAccept(
        env,
        { date: payload.date, calendar: payload.calendar === true },
        nowMs,
        ctx,
      );
      return { prev, result };
    },
    async undo(env, snapshot, nowMs) {
      await undoPlanAccept(env, snapshot, nowMs);
    },
  },
  'plan.update': {
    async execute(env, payload, nowMs) {
      const { result, prev } = await runPlanUpdate(
        env,
        { date: payload.date, done: payload.done, moves: payload.moves, drop: payload.drop },
        nowMs,
      );
      return { prev, result };
    },
    async undo(env, snapshot) {
      await undoPlanUpdate(env, snapshot);
    },
  },
  'plan.review': {
    async execute(env, payload, nowMs) {
      const { result } = await runPlanReview(
        env,
        { date: payload.date, carry: payload.carry },
        nowMs,
      );
      return { result };
    },
  },
  // forget (T2): target вирішує, що саме стирається. Колекція - тут; чат -
  // етап 6, «усе» - етап 7 (експорт спершу) - до того чесна відмова.
  forget: {
    async execute(env, payload) {
      const target = String(payload.target ?? (payload.collection != null ? 'collection' : ''));
      if (target === 'collection') {
        const { name, records } = await deleteCollection(env, payload.collection ?? payload.id);
        return { result: { erased: `колекція «${name}» (${records} зап.)` } };
      }
      // S-2-8: чат цілком - повідомлення, індекс і дайджести ЛИШЕ про нього.
      if (target === 'chat') {
        const { messages, digests } = await forgetChat(env, payload.chat ?? payload.name);
        return {
          result: {
            erased: `${messages} ${plural(messages, 'повідомлення', 'повідомлення', 'повідомлень')} і ${digests} ${plural(digests, 'дайджест', 'дайджести', 'дайджестів')}`,
            messages,
            digests,
          },
        };
      }
      // S-0-5 «усе»: T2 зі словом. Експорт спершу - це порада в самому
      // повідомленні меню, а не гейт у коді: вимагати доказу експорту
      // означало б, що власник не може стерти дані, доки Drive недоступний.
      if (target === 'all') {
        const { tables, rows, kvKeys } = await forgetAll(env);
        return {
          result: {
            erased: `${rows} ${plural(rows, 'рядок', 'рядки', 'рядків')} у ${tables} таблицях і ${kvKeys} ${plural(kvKeys, 'ключ', 'ключі', 'ключів')} KV`,
            rows,
            tables,
            kvKeys,
          },
        };
      }
      throw new Error(`forget: ціль «${target}» невідома (chat | collection | all)`);
    },
  },
  // Експорт даних (S-0-6): T2 - див. шапку core/export/data-export.mjs про
  // суперечність канону з 04-scenarios.
  'data.export': {
    async execute(env, payload, nowMs) {
      void payload; // експорт не має параметрів: беруться ВСІ дані
      const out = await runDataExport(env, nowMs);
      return { result: out };
    },
  },
  // Нотатка в Drive (S-8-3, 07 §4 drive.write): T1, тека «Світанок/нотатки».
  // Тут - НЕ uploadMarkdown: той best-effort і віддає null при збої, бо
  // документ у власника вже є. Після ✅ такої підстраховки немає, тож збій
  // мусить бути винятком.
  'drive.write': {
    async execute(env, payload) {
      const name = driveNoteName(payload.name);
      const content = String(payload.content_md ?? payload.content ?? '');
      if (!content.trim()) throw new Error('drive.write: порожній вміст нотатки');
      if (content.length > DRIVE_NOTE_MAX_CHARS) {
        throw new Error(`drive.write: нотатка довша за ${DRIVE_NOTE_MAX_CHARS} символів`);
      }
      const folderId = await ensureFolderPath(env, DRIVE_NOTES_PATH);
      const file = await uploadFile(env, {
        name,
        parentId: folderId,
        bytes: new TextEncoder().encode(content),
        mimeType: 'text/markdown',
      });
      return {
        result: {
          file_id: file.id,
          name: file.name,
          folder: DRIVE_NOTES_PATH.join('/'),
          // Лінк - щоб модель дала СПРАВЖНЄ посилання, а не назву файла.
          link: file.link,
        },
      };
    },
  },
  // Налаштування Mini App (07 §4 kind=settings, T1): той самий блоб KV, що
  // пише /api/settings, і та сама нормалізація - інакше модель могла б
  // покласти туди форму, якої фронт не читає.
  settings: {
    async execute(env, payload) {
      const patch = payload.patch ?? payload.settings ?? payload;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('settings: потрібен обʼєкт із полями quiet/modules/mutedTopics');
      }
      const current = await loadSettings(env);
      const next = normalizeSettings({
        ...current,
        ...patch,
        quiet: { ...current.quiet, ...(patch.quiet ?? {}) },
        modules: { ...current.modules, ...(patch.modules ?? {}) },
      });
      await env.BRIEFING.put('settings', JSON.stringify(next));
      return { prev: current, result: next };
    },
    async undo(env, snapshot) {
      await env.BRIEFING.put('settings', JSON.stringify(normalizeSettings(snapshot)));
    },
  },
  // Gemini (ADR-012/ADR-034, S-8-5/S-8-6, етап 7 PR-3). Ціну власник бачить у
  // самій пропозиції - її дописує ЯДРО (policy/core.mjs proposalNotice), не
  // модель. Тут лишається витрата: згенерувати, доставити, порахувати.
  //
  // Порядок «доставити → порахувати» неспроста: квота міряє ГРОШІ, а вони
  // списані в момент генерації. Якби лічильник ішов лише після успішної
  // доставки, невдала відправка робила б витрату невидимою для стелі.
  'gemini.image': {
    async execute(env, payload, nowMs, ctx) {
      const { bytes, mime } = await generateImage(env, { prompt: String(payload.prompt ?? '') });
      const cost = IMAGE_USD;
      try {
        await deliverGenerated(env, ctx, {
          kind: 'photo',
          bytes,
          mime,
          filename: 'svitanok.png',
          caption: `≈ $${cost.toFixed(2)}`,
        });
      } finally {
        await countGeminiSpend(env, cost, nowMs);
      }
      return { result: { generated: 'image', usd: cost, bytes: bytes.length } };
    },
  },
  'gemini.video': {
    async execute(env, payload, nowMs, ctx) {
      const { seconds, model } = videoParams(payload);
      const { bytes, mime } = await generateVideo(env, {
        prompt: String(payload.prompt ?? ''),
        seconds,
        model,
      });
      const cost = videoUsd(seconds, model);
      try {
        await deliverGenerated(env, ctx, {
          kind: 'video',
          bytes,
          mime,
          filename: 'svitanok.mp4',
          caption: `${seconds} с, ≈ $${cost.toFixed(2)}`,
        });
      } finally {
        await countGeminiSpend(env, cost, nowMs);
      }
      return { result: { generated: 'video', usd: cost, seconds, model } };
    },
  },
  // Google Tasks (S-8-4, етап 7 PR-1): T1, без «↩» - видалити чужу задачу
  // одним рухом Tasks API не дає без окремого скоупа на видалення, а
  // «відкотив» без реального видалення було б брехнею.
  'tasks.create': {
    async execute(env, payload) {
      const { id, title, due, link } = await createTask(env, {
        title: payload.title,
        notes: payload.notes,
        due: payload.due ?? payload.date ?? null,
      });
      return { result: { task_id: id, title, due, link } };
    },
  },
  'collection.export': {
    async execute(env, payload, nowMs, ctx) {
      const csv = await exportCollectionCsv(env, payload.collection);
      // to=sheets (S-N4-4): та сама вибірка, інша адреса доставки - Google
      // Таблиця в «Світанок/export/» замість документа в чат. Дефолт лишився
      // файлом: він працює без Drive і без мережі власника.
      if (String(payload.to ?? '') === 'sheets') {
        const folderId = await ensureFolderPath(env, EXPORT_FOLDER_PATH);
        const sheet = await uploadCsvAsSheet(env, {
          name: csv.filename.replace(/\.csv$/, ''),
          parentId: folderId,
          csv: csv.content,
        });
        return {
          result: { sheet_id: sheet.id, name: sheet.name, link: sheet.link, rows: csv.rows },
        };
      }
      // Адреса: чат прогону, а після ✅ (resolveProposal) - за thread_id
      // пропозиції: тема супергрупи або DM власника.
      const threadKey = ctx?.threadId == null ? null : String(ctx.threadId);
      const isDm = threadKey === 'dm';
      const chatId =
        ctx?.chatId ??
        (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (env.TELEGRAM_CHAT_ID ?? null));
      if (chatId == null) throw new Error('collection.export: чат для документа невідомий');
      await enqueueOutbox(
        env,
        {
          chatId,
          threadId: isDm || threadKey == null ? null : Number(threadKey),
          kind: 'document',
          payload: {
            filename: csv.filename,
            content: csv.content,
            caption: `Експорт: ${csv.rows} рядк.`,
          },
        },
        nowMs,
      );
      await drainOutbox(env, { nowMs }).catch(() => {});
      return { result: { filename: csv.filename, rows: csv.rows } };
    },
  },
  // Ланцюги (07 §4 chain.start/cancel): table (PR-2), price (PR-3), trip
  // (PR-4). Кожен kind - свій стартер; невідомий - чесна відмова.
  'chain.start': {
    async execute(env, payload, nowMs, ctx) {
      const kind = String(payload.kind ?? '');
      const inner = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
      if (kind === 'table') {
        const { result, prev } = await startTableChain(env, inner, nowMs, {
          chatId: ctx?.chatId ?? null,
          threadId: ctx?.threadId ?? null,
        });
        return { result, prev };
      }
      if (kind === 'price') {
        // Відстеження ціни (S-5-11): бажання за id або нове purchase з url.
        if (inner.wish_id) {
          const wish = await findWish(env, inner.wish_id);
          if (!wish) throw new Error(`бажання «${String(inner.wish_id)}» немає`);
          if (typeof wish.payload.url !== 'string') {
            throw new Error('у бажання немає url - додай посилання через wishes.update');
          }
          const out = await startPriceTrack(
            env,
            {
              id: wish.id,
              title: wish.title,
              url: wish.payload.url,
              target_price: wish.payload.target_price ?? null,
              currency: String(wish.payload.currency ?? 'UAH'),
            },
            nowMs,
            { chatId: ctx?.chatId ?? null, threadId: ctx?.threadId ?? null },
          );
          return {
            result: {
              chain_id: out.chainId,
              wish_id: wish.id,
              text: out.existing
                ? `«${wish.title}» уже відстежую`
                : trackingText(
                    wish.title,
                    wish.payload.target_price ?? null,
                    String(wish.payload.currency ?? 'UAH'),
                  ),
            },
            prev: out.existing ? undefined : { kind, chain_id: out.chainId, wish_id: wish.id },
          };
        }
        // type завжди purchase: модель могла покласти в payload своє поле.
        const created = await runWishesCreate(env, { ...inner, type: 'purchase' }, nowMs, {
          chatId: ctx?.chatId ?? null,
          threadId: ctx?.threadId ?? null,
        });
        return {
          result: created.result,
          prev: {
            kind,
            chain_id: created.result.chain_id ?? null,
            wish_id: created.prev.id,
            created: true,
          },
        };
      }
      if (kind === 'trip') {
        // Поїздка (S-5-5): нова або - з trip_id - нові дати наявної.
        const { result, prev } = await startTripChain(env, inner, nowMs, {
          chatId: ctx?.chatId ?? null,
          threadId: ctx?.threadId ?? null,
        });
        return { result, prev: prev ? { kind, ...prev } : undefined };
      }
      throw new Error(`chain.start: невідомий kind «${kind}»; дозволені: table, price, trip`);
    },
    async undo(env, snapshot, nowMs) {
      // «↩» одразу після старту = скасування (S-1-12): ланцюг cancelled,
      // Workflow прокидається подією; для price створене бажання теж геть.
      if (snapshot.kind === 'price') {
        if (snapshot.created) {
          await deleteWishRow(env, String(snapshot.wish_id), nowMs);
          return;
        }
        if (!(await cancelPriceTrack(env, String(snapshot.wish_id), nowMs))) {
          throw new Error('відстеження вже не активне - зупиняти нічого');
        }
        return;
      }
      if (snapshot.kind === 'trip') {
        if (!(await cancelTripChain(env, String(snapshot.trip_id), nowMs))) {
          throw new Error('поїздка вже не активна - скасовувати нічого');
        }
        return;
      }
      if (!(await cancelTableChain(env, String(snapshot.chain_id)))) {
        throw new Error('ланцюг уже не активний - скасовувати нічого');
      }
    },
  },
  'chain.cancel': {
    async execute(env, payload, nowMs) {
      const kind = payload.kind == null ? 'table' : String(payload.kind);
      const chainId = payload.chain_id ? String(payload.chain_id) : null;
      if (kind === 'price') {
        const active = await findActivePriceChain(env, { chainId });
        if (!active) throw new Error('активного відстеження ціни немає');
        await cancelPriceChain(env, active.id, nowMs);
        return {
          result: {
            cancelled: true,
            chain_id: active.id,
            title: active.title,
            text: `Зупинив відстеження «${active.title}»`,
          },
        };
      }
      if (kind === 'trip') {
        const ref = payload.trip_id ? String(payload.trip_id) : (chainId ?? null);
        const trip = await cancelTripChain(env, ref, nowMs);
        if (!trip) throw new Error('активної поїздки немає');
        return {
          result: {
            cancelled: true,
            trip_id: trip.id,
            text: `Скасував поїздку «${trip.to}»`,
          },
        };
      }
      if (kind !== 'table') {
        throw new Error(
          `chain.cancel: скасувати можна table, price або trip (kind «${kind}» невідомий)`,
        );
      }
      const active = await findActiveTableChain(env, chainId);
      if (!active) throw new Error('активного ланцюга столика немає');
      const ok = await cancelTableChain(env, active.id);
      return {
        result: {
          cancelled: ok,
          chain_id: active.id,
          venue: active.venue,
          text: `Скасував ланцюг «столик у ${active.venue}»`,
        },
      };
    },
  },
  // Бажання (етап 5 PR-3): create/update - T0 з «↩», delete - T1.
  'wishes.create': {
    async execute(env, payload, nowMs, ctx) {
      const { result, prev } = await runWishesCreate(
        env,
        {
          type: payload.type,
          title: payload.title,
          url: payload.url,
          target_price: payload.target_price,
          currency: payload.currency,
          steam_appid: payload.steam_appid,
        },
        nowMs,
        { chatId: ctx?.chatId ?? null, threadId: ctx?.threadId ?? null },
      );
      return { result, prev };
    },
    async undo(env, snapshot, nowMs) {
      await deleteWishRow(env, String(snapshot.id), nowMs);
    },
  },
  // Імпорт wishlist Steam (S-5-2): T0 з «↩» - відкат прибирає рівно ті
  // бажання, які створив імпорт.
  'wishes.import': {
    async execute(env, payload, nowMs) {
      const source = payload.source == null ? 'steam' : String(payload.source);
      if (source !== 'steam')
        throw new Error(`wishes.import: джерело «${source}» не підтримується`);
      return importSteamWishlist(env, payload, nowMs);
    },
    async undo(env, snapshot, nowMs) {
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids.map(String) : [];
      for (const id of ids) await deleteWishRow(env, id, nowMs);
    },
  },
  'wishes.update': {
    async execute(env, payload, nowMs) {
      const { result, prev } = await runWishesUpdate(
        env,
        {
          id: payload.id,
          title: payload.title,
          url: payload.url,
          target_price: payload.target_price,
          currency: payload.currency,
          status: payload.status,
        },
        nowMs,
      );
      return { result, prev };
    },
    async undo(env, snapshot) {
      await restoreWish(env, snapshot);
    },
  },
  'wishes.delete': {
    async execute(env, payload, nowMs) {
      const { result } = await runWishesDelete(env, { id: payload.id }, nowMs);
      return { result };
    },
  },
  // Гроші (етап 6 PR-2). Обидва - записи у ВЛАСНУ базу, тож T0 з «↩».
  // ⚠️ Знімок `finance.rule` несе не лише рядок правила, а й СТАРУ категорію
  // кожної перекладеної транзакції: вони різні (частина з довідника MCC,
  // частина з іншого правила), і «зворотним правилом» їх не відновити - без
  // цього «↩» була б неправдою на T0-дії, яка виконується без ✅.
  // subscriptions.update повертає рівно ті статус і дату, що були.
  'finance.rule': {
    async execute(env, payload) {
      const { result, prev } = await runFinanceRule(env, {
        pattern: payload.pattern,
        category: payload.category,
        is_subscription: payload.is_subscription,
      });
      return { result, prev };
    },
    async undo(env, snapshot) {
      await restoreRule(env, snapshot);
    },
  },
  'subscriptions.update': {
    async execute(env, payload) {
      const result = await updateSubscription(env, {
        id: payload.id,
        status: payload.status,
        next_at: payload.next_at,
      });
      return { result, prev: { id: result.id, ...result.before } };
    },
    async undo(env, snapshot) {
      if (!snapshot?.id) return;
      await updateSubscription(env, {
        id: String(snapshot.id),
        status: String(snapshot.status),
        // Саме `null`, а не `undefined`: підписці без дати «↩» мусить
        // повернути її відсутність, а не лишити щойно проставлену.
        next_at: snapshot.next_at ?? null,
      });
    },
  },
  // Календар (етап 5 PR-2 - мінімум для S-1-9/S-1-10; повна Google-ревізія -
  // етап 7): після ✅ подія створюється справді, а не «виконавця ще немає».
  'calendar.event': {
    async execute(env, payload) {
      return { result: await createEventFromPayload(env, payload, false) };
    },
  },
  invite: {
    async execute(env, payload) {
      return { result: await createEventFromPayload(env, payload, true) };
    },
  },
  // Правка й видалення події (07 §4, ACTION_LEVELS T1) - етап 7 PR-1,
  // «Google-ревізія»: рівні для них стояли в таблиці з етапу 1, а виконавців
  // не було, тож ✅ власника впирався в «no-executor». Адаптери
  // (updateCalendarEvent/deleteCalendarEvent) чинні з фази 5.
  'calendar.update': {
    async execute(env, payload) {
      await assertGoogleScope(env, 'calendar');
      const eventId = calendarEventId(payload);
      const patch = await buildEventPatch(env, payload);
      const res = await updateCalendarEvent(env, { eventId, patch });
      if (!res.ok) throw new Error('calendar: Google не змінив подію (лог)');
      return { result: { event_id: eventId, changed: Object.keys(patch) } };
    },
  },
  'calendar.delete': {
    async execute(env, payload) {
      await assertGoogleScope(env, 'calendar');
      const eventId = calendarEventId(payload);
      const res = await deleteCalendarEvent(env, { eventId });
      if (!res.ok) throw new Error('calendar: Google не видалив подію (лог)');
      return { result: { event_id: eventId, deleted: true } };
    },
  },
  // Новий контакт у Google Contacts (07 §4 kind=contact, T1). Не плутати з
  // facts.contact: той - локальний факт ядра (T0), цей - запис у чужому
  // сервісі, тож лише через ✅.
  contact: {
    async execute(env, payload) {
      await assertGoogleScope(env, 'contacts');
      const name = String(payload.name ?? payload.title ?? '')
        .trim()
        .slice(0, 120);
      const email = String(payload.email ?? '').trim();
      if (!name) throw new Error('contact: потрібне імʼя');
      if (!CONTACT_EMAIL_RE.test(email)) throw new Error(`contact: «${email}» не схоже на email`);
      const res = await createContact(env, { name, email });
      if (!res.ok) throw new Error('contact: Google не створив контакт (лог)');
      return { result: { name, email } };
    },
  },
  'facts.set': {
    async execute(env, payload, nowMs) {
      const before = await runFactsGet(env, { kind: payload.kind, key: payload.key });
      const prev = before.result[0] ?? null; // null = факту не існувало
      const { result } = await runFactsSet(env, payload, nowMs);
      return { prev: { key: payload.key, kind: payload.kind, prev }, result };
    },
    async undo(env, snapshot, nowMs) {
      if (snapshot.prev == null) {
        // Факту не було - відкат = видалення.
        if (!env.DB) throw new Error('привʼязки DB немає');
        await env.DB.prepare('DELETE FROM facts WHERE kind = ? AND key = ?')
          .bind(snapshot.kind, snapshot.key)
          .run();
        return;
      }
      await runFactsSet(
        env,
        {
          kind: snapshot.kind,
          key: snapshot.key,
          value: snapshot.prev.value,
          source: snapshot.prev.source,
        },
        nowMs,
      );
    },
  },
};

/**
 * Подія в Google Calendar з payload пропозиції (calendar.event / invite):
 * title, startIso, endIso обовʼязкові; attendees - email-и або імена (імена
 * резолвить Contacts; для invite без жодного email - відмова, не тиха подія
 * без гостей).
 * @param {Env} env @param {Record<string, any>} payload @param {boolean} requireAttendees
 */
async function createEventFromPayload(env, payload, requireAttendees) {
  await assertGoogleScope(env, 'calendar');
  const title = String(payload.title ?? '')
    .trim()
    .slice(0, 200);
  const startMs = Date.parse(String(payload.startIso ?? ''));
  const endMs = Date.parse(String(payload.endIso ?? ''));
  if (!title || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('calendar: потрібні title, startIso, endIso (кінець після початку)');
  }
  const { emails, notes } = await resolveAttendees(env, payload.attendees);
  if (requireAttendees && emails.length === 0) {
    throw new Error(`invite: жодного email (${notes.join('; ') || 'учасників не вказано'})`);
  }
  const reminderMinutes =
    typeof payload.reminderMinutes === 'number' &&
    Number.isInteger(payload.reminderMinutes) &&
    payload.reminderMinutes >= 0 &&
    payload.reminderMinutes <= 40_320
      ? payload.reminderMinutes
      : undefined;
  const created = await createCalendarEvent(env, {
    title,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    reminderMinutes,
    location: typeof payload.location === 'string' ? payload.location : null,
    attendees: emails.length ? emails : null,
  });
  if (!created.ok) throw new Error('calendar: Google не створив подію (лог)');
  return { title, event_id: created.id, attendees: emails, notes };
}

/** id події їде в ШЛЯХ URL (google.mjs calendarEventUrl не екранує - «валідує
 *  викликач»), тож формат перевіряється тут, до будь-якої мережі. */
// Мусить ПОЧИНАТИСЬ з букви/цифри: інакше `..` проходив фільтр, а WHATWG-URL
// згортав сегмент - і PATCH прилітав у ресурс КАЛЕНДАРЯ замість події
// (ревʼю етапу 7).
const EVENT_ID_RE = /^[A-Za-z0-9_@][A-Za-z0-9_@.-]{0,1023}$/;
/** Той самий грубий фільтр, що в google.mjs: People API все одно перевірить. */
const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {Record<string, any>} payload */
function calendarEventId(payload) {
  const id = String(payload.event_id ?? payload.eventId ?? payload.id ?? '').trim();
  if (!EVENT_ID_RE.test(id)) throw new Error('calendar: потрібен event_id події');
  return id;
}

/**
 * Патч події з payload пропозиції: у Google їдуть ЛИШЕ названі поля - патч із
 * зайвими ключами тихо переписав би те, чого власник не бачив у пропозиції.
 * Порожній патч - помилка, а не «успішно нічого не змінив».
 * @param {Env} env @param {Record<string, any>} payload
 */
async function buildEventPatch(env, payload) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  const title = String(payload.title ?? '').trim();
  if (title) patch.summary = title.slice(0, 200);
  if (typeof payload.location === 'string' && payload.location.trim()) {
    patch.location = payload.location.trim().slice(0, 300);
  }
  const startMs = payload.startIso == null ? NaN : Date.parse(String(payload.startIso));
  const endMs = payload.endIso == null ? NaN : Date.parse(String(payload.endIso));
  // Час міняється ЛИШЕ парою: Google приймає патч одного кінця, і подія з
  // кінцем раніше початку стає невидимою в сітці дня.
  if (Number.isFinite(startMs) !== Number.isFinite(endMs)) {
    throw new Error('calendar: час міняється парою startIso+endIso');
  }
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    if (endMs <= startMs) throw new Error('calendar: кінець події раніше за початок');
    patch.start = { dateTime: new Date(startMs).toISOString(), timeZone: 'Europe/Kyiv' };
    patch.end = { dateTime: new Date(endMs).toISOString(), timeZone: 'Europe/Kyiv' };
  }
  if (payload.attendees != null) {
    const { emails } = await resolveAttendees(env, payload.attendees);
    if (emails.length) patch.attendees = emails.map((email) => ({ email }));
  }
  if (Object.keys(patch).length === 0) throw new Error('calendar: у патчі немає жодного поля');
  return patch;
}

/**
 * Параметри відео з payload: довжина в межах канону (S-8-6 називає ціну за
 * 8 с) і модель. Кривий ввід - не «за замовчуванням», а межа: більше за
 * стелю мовчки коштувало б власнику грошей понад показану ціну.
 * @param {Record<string, any>} payload
 * @returns {{ seconds: number, model: 'veo' | 'lite' }}
 */
function videoParams(payload) {
  // Основний clamp живе в sanitizeGeminiPayload (щоб ціна й витрата рахувались
  // з ОДНОГО числа); тут він лишається страховкою для шляхів повз санітизацію.
  const raw = Number(payload.seconds);
  const seconds = Number.isFinite(raw)
    ? Math.min(Math.max(Math.round(raw), 1), VIDEO_MAX_SECONDS)
    : VIDEO_DEFAULT_SECONDS;
  return { seconds, model: payload.model === 'lite' ? 'lite' : 'veo' };
}

/**
 * Стеля витрат Gemini ПЕРЕД пропозицією: місячний ліміт `gemini_usd` з
 * quota_counters. Повертає текст відмови або null.
 * @param {Env} env @param {string} kind @param {Record<string, unknown>} payload @param {number} nowMs
 */
async function geminiQuotaGuard(env, kind, payload, nowMs) {
  if (!env.DB) return null; // без бази облік неможливий - не блокуємо дію мовчки
  const { seconds, model } = videoParams(/** @type {any} */ (payload));
  const cost = kind === 'gemini.image' ? IMAGE_USD : videoUsd(seconds, model);
  try {
    const limit = quotaLimitOf('gemini_usd');
    const used = await quotaUsed(env, 'gemini_usd', nowMs);
    if (used + cost > limit) {
      return `Стеля витрат Gemini на місяць вичерпана: використано $${used.toFixed(2)} із $${limit.toFixed(2)}, ця генерація коштує $${cost.toFixed(2)}.`;
    }
  } catch (/** @type {any} */ e) {
    // Облік не прочитався - це не привід тихо витратити гроші.
    return `облік витрат Gemini недоступний: ${String(e?.message ?? '')}`;
  }
  return null;
}

/** Порахувати витрачене (алерти 80/100 % - усередині bumpQuota).
 *  @param {Env} env @param {number} usd @param {number} nowMs */
async function countGeminiSpend(env, usd, nowMs) {
  try {
    await bumpQuota(env, {
      key: 'gemini_usd',
      amount: usd,
      limit: quotaLimitOf('gemini_usd'),
      nowMs,
    });
  } catch (/** @type {any} */ e) {
    // Гроші вже витрачені; збій обліку не сміє зробити вигляд, що дії не було.
    console.error('gemini: витрата не порахована', e?.message);
  }
}

/**
 * Доставити згенероване в тред пропозиції. Медіа йде повз чергу (розмір), тож
 * адреса рахується так само, як у collection.export.
 * @param {Env} env
 * @param {{ chatId?: number | string | null, threadId?: number | string | null } | undefined} ctx
 * @param {{ kind: 'photo' | 'video', bytes: Uint8Array, mime: string, filename: string, caption: string }} media
 */
async function deliverGenerated(env, ctx, media) {
  const threadKey = ctx?.threadId == null ? null : String(ctx.threadId);
  const isDm = threadKey === 'dm';
  const chatId =
    ctx?.chatId ?? (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (env.TELEGRAM_CHAT_ID ?? null));
  if (chatId == null) throw new Error('gemini: чат для доставки невідомий');
  await sendMediaBytes(
    env,
    { chatId, threadId: isDm || threadKey == null ? null : Number(threadKey) },
    media,
  );
}

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - policy неможлива');
  return env.DB;
}

/**
 * Виконати ДІЮ за політикою: T0 (у чистій сесії) - одразу + undo-рядок;
 * T1/T2 (і будь-що в tainted) - пропозиція з кнопками. Це єдиний вхід для
 * write-шляхів router'а.
 * @param {Env} env
 * @param {{ kind: string, payload: Record<string, unknown>,
 *   threadId?: string | number | null, chatId?: number | string | null,
 *   tainted: boolean, taintedEver?: boolean, viaProposal?: boolean }} action - viaProposal: дію
 *   просить обгортка proposals.create (тоді T0 заборонений)
 * @param {number} nowMs
 * @returns {Promise<
 *   | { mode: 'executed', result: unknown, undo?: { id: string, buttons: unknown } }
 *   | { mode: 'proposed', proposal: { id: string, level: string, word: string | null,
 *       expires_at: string, buttons: unknown } }
 *   | { mode: 'error', error: string }>}
 */
export async function applyPolicy(env, action, nowMs) {
  const decision = decideLevel(action.kind, action.tainted, action.payload);
  if ('error' in decision) return { mode: 'error', error: decision.error };
  let level = decision.level;

  // source='owner' - привласнення слів власника, і воно потребує ЙОГО ✅:
  // 07 §4 дозволяє виводу моделі лише inferred, тож T0-шлях із owner
  // ескалюється до пропозиції (після ✅ attribution легітимний).
  if (level === 'T0' && action.kind === 'facts.set' && action.payload.source === 'owner') {
    level = 'T1';
  }

  // ⚠️ Гейт стоїть ПІСЛЯ ескалацій (security-ревʼю PR-6): обгортка
  // proposals.create просить підтвердження - і мусить його дати. Інакше через
  // неї модель виконувала б T0-дії миттєво й повз схему самого інструмента,
  // хоча опис у мозку обіцяє власнику протилежне. Дія, яку ескалювали до
  // T1 (напр. facts.set із source=owner), через обгортку легітимна.
  if (action.viaProposal && level === 'T0') {
    return {
      mode: 'error',
      error: `direct-tool: ${action.kind} - це T0, клич інструмент напряму, не proposals.create`,
    };
  }

  // Gemini (ADR-034): у чужий сервіс їде РІВНО prompt власника.
  //
  // Два барʼєри, і обидва тут, у ядрі, а не в описі інструмента.
  //   1. Заплямована сесія - ВІДМОВА, не ескалація до ✅. Taint означає, що
  //      модель щойно читала пошту або чужі чати, і будь-який текст, який
  //      вона зараз складає, може нести їхній вміст. Ескалація тут не
  //      допомогла б: власник підтвердив би картинку, не бачачи, що в
  //      prompt-і переказано лист. Порада в тексті - /new.
  //   2. Білий список полів: усе, крім prompt (і двох параметрів формату), -
  //      помилка, тож id транзакції чи чату просто не має куди поїхати.
  if (action.kind === 'gemini.image' || action.kind === 'gemini.video') {
    // ⚠️ Не 10-хвилинний taint, а «читала зовнішнє ХОЧ РАЗ від /new»
    // (security-ревʼю етапу 7): сесія мозку переживає межу прогону, і через
    // 15 хвилин після листа його вміст усе ще в контексті - а звичайний taint
    // уже прострочений. `taintedEver` не задано (виклики повз router) -
    // падаємо на `tainted`, тобто барʼєр не слабший за попередній.
    if (action.taintedEver ?? action.tainted) {
      return {
        mode: 'error',
        error: `${action.kind}: сесія вже читала зовнішній вміст (пошта/чати) - у Gemini з неї нічого не йде. Почни /new і повтори запит.`,
      };
    }
    const narrowed = sanitizeGeminiPayload(action.kind, action.payload);
    if ('error' in narrowed) return { mode: 'error', error: narrowed.error };
    action = { ...action, payload: narrowed.payload };
    // Стеля витрат - ДО пропозиції: показати ціну й отримати ✅, а вже потім
    // упертись у квоту означало б витратити рішення власника даремно.
    const guard = await geminiQuotaGuard(env, action.kind, narrowed.payload, nowMs);
    if (guard) return { mode: 'error', error: guard };
  }

  // kind факту звіряємо ДО виконання чи пропозиції (приймання 05.09, B1):
  // модель обрала «preference», перевірка стояла лише у виконавці, і помилка
  // вилізла вже після ✅ власника. Тепер модель дістає відмову з переліком
  // одразу. Гейт ПІСЛЯ direct-tool: той висновок важливіший за деталі payload.
  if (action.kind === 'facts.set' && !FACT_KINDS.includes(String(action.payload?.kind))) {
    return {
      mode: 'error',
      error: `facts.set: невідомий kind "${String(action.payload?.kind)}"; дозволені: ${FACT_KINDS.join(', ')}`,
    };
  }

  if (level === 'T0') {
    const executor = EXECUTORS[action.kind];
    if (!executor) return { mode: 'error', error: `no-executor: ${action.kind}` };
    const { prev, result } = await executor.execute(env, action.payload, nowMs, {
      chatId: action.chatId ?? null,
      threadId: action.threadId ?? null,
    });
    if (prev === undefined || !executor.undo) return { mode: 'executed', result };
    try {
      const undoId = crypto.randomUUID();
      await insertRow(env, {
        id: undoId,
        level: 'T0',
        kind: `undo:${action.kind}`,
        payloadJson: JSON.stringify(prev),
        threadId: action.threadId,
        word: null,
        expiresAt: new Date(nowMs + UNDO_WINDOW_MS).toISOString(),
        nowMs,
      });
      return { mode: 'executed', result, undo: { id: undoId, buttons: undoButton(undoId) } };
    } catch (/** @type {any} */ e) {
      // Дію ВЖЕ виконано - збій undo-рядка не сміє звітувати «не виконано»
      // (мозок повторив би запис). Просто без кнопки «↩», зі слідом у логах.
      console.error('policy: undo-рядок не записано (дія виконана)', e?.message);
      return { mode: 'executed', result };
    }
  }

  const id = crypto.randomUUID();
  const proposalLevel = /** @type {'T1' | 'T2'} */ (level); // T0 повернувся вище
  const word = proposalLevel === 'T2' ? pickT2Word() : null;
  const expiresAt = new Date(nowMs + PROPOSAL_TTL_MS[proposalLevel]).toISOString();
  await insertRow(env, {
    id,
    level,
    kind: action.kind,
    payloadJson: JSON.stringify(action.payload),
    threadId: action.threadId,
    word,
    expiresAt,
    nowMs,
  });
  return {
    mode: 'proposed',
    proposal: {
      id,
      level,
      word,
      expires_at: expiresAt,
      buttons: proposalButtons(id),
    },
  };
}

/**
 * Рішення власника по пропозиції (callback `p:`). Ідемпотентно: рішення по
 * вже вирішеній - {already}; прострочена - позначається expired.
 * @param {Env} env
 * @param {{ id: string, choice: 'ok' | 'no', word?: string | null }} input
 * @param {number} nowMs
 * @returns {Promise<
 *   | { ok: true, status: 'approved', executed: boolean, kind: string, payload?: unknown, result?: unknown, error?: string }
 *   | { ok: true, status: 'rejected' | 'expired', kind: string, payload: unknown }
 *   | { ok: true, already: string }
 *   | { ok: false, error: string }>}
 */
export async function resolveProposal(env, input, nowMs) {
  const row = await loadRow(env, input.id);
  if (!row || row.kind.startsWith('undo:')) return { ok: false, error: 'unknown-proposal' };
  if (row.status !== 'open') return { ok: true, already: row.status };
  if (Date.parse(row.expires_at) <= nowMs) {
    await setStatus(env, row.id, 'expired', nowMs);
    return { ok: true, status: 'expired', kind: row.kind, payload: shownPayload(row) };
  }
  if (input.choice === 'no') {
    await setStatus(env, row.id, 'rejected', nowMs);
    return { ok: true, status: 'rejected', kind: row.kind, payload: shownPayload(row) };
  }
  if (row.level === 'T2') {
    // Слово - другий фактор T2: без нього ✅ не достатньо (01 §4.3).
    if ((input.word ?? '').trim().toUpperCase() !== row.word) {
      return { ok: false, error: 'word-required' };
    }
  }
  const executor = EXECUTORS[row.kind];
  if (!executor) {
    // Прийнято, а виконати нічим (виконавець прийде пізнішим етапом) -
    // кажемо вголос, пропозицію лишаємо open: власник не винен, що рано.
    return { ok: false, error: `no-executor: ${row.kind}` };
  }
  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { ok: false, error: 'bad-payload' };
  }
  // CLAIM ПЕРЕД виконанням (TOCTOU): подвійний тап ✅ = два вебхуки = два
  // конкурентні resolve, і обидва бачили status='open' вище. CAS пускає до
  // виконавця рівно одного; на етапі 2 це різниця між однією і двома подіями
  // в календарі.
  if (!(await setStatus(env, row.id, 'approved', nowMs))) {
    return { ok: true, already: 'approved' };
  }
  try {
    // Контекст після ✅: chatId прогону вже невідомий, лишається тред
    // пропозиції - виконавцям, що щось шлють (експорт), цього досить.
    const { result } = await executor.execute(env, payload, nowMs, {
      chatId: null,
      threadId: row.thread_id,
    });
    return { ok: true, status: 'approved', executed: true, kind: row.kind, payload, result };
  } catch (/** @type {any} */ e) {
    // Клейм уже стоїть (повтор не переграє) - збій виконання кажемо вголос.
    console.error(`policy: виконання ${row.kind} після ✅ впало`, e?.message);
    return { ok: false, error: `execute-failed: ${String(e?.message ?? '')}` };
  }
}

/**
 * «↩» по T0 (callback `u:`): відкат у вікні 10 хв, ідемпотентно.
 * @param {Env} env
 * @param {string} id
 * @param {number} nowMs
 * @returns {Promise<{ ok: true, status: 'undone' | 'expired' } | { ok: true, already: string } | { ok: false, error: string }>}
 */
export async function resolveUndo(env, id, nowMs) {
  const row = await loadRow(env, id);
  if (!row || !row.kind.startsWith('undo:')) return { ok: false, error: 'unknown-undo' };
  if (row.status !== 'open') return { ok: true, already: row.status };
  if (Date.parse(row.expires_at) <= nowMs) {
    await setStatus(env, id, 'expired', nowMs);
    return { ok: true, status: 'expired' };
  }
  const baseKind = row.kind.slice('undo:'.length);
  const executor = EXECUTORS[baseKind];
  if (!executor?.undo) return { ok: false, error: `no-executor: ${baseKind}` };
  /** @type {any} */
  let snapshot;
  try {
    snapshot = JSON.parse(row.payload_json);
  } catch {
    return { ok: false, error: 'bad-payload' };
  }
  // Той самий claim-first, що в resolveProposal: подвійний «↩» - один відкат.
  if (!(await setStatus(env, id, 'approved', nowMs))) {
    return { ok: true, already: 'approved' };
  }
  await executor.undo(env, snapshot, nowMs); // approved = «↩ застосовано»
  return { ok: true, status: 'undone' };
}

/**
 * @param {Env} env
 * @param {{ id: string, level: string, kind: string, payloadJson: string,
 *   threadId?: string | number | null, word: string | null, expiresAt: string,
 *   nowMs: number }} row
 */
async function insertRow(env, row) {
  await db(env)
    .prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, word, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(
      row.id,
      row.level,
      row.kind,
      row.payloadJson,
      row.threadId == null ? null : String(row.threadId),
      row.word,
      row.expiresAt,
      new Date(row.nowMs).toISOString(),
    )
    .run();
}

/** Payload для тексту рішення власнику; кривий JSON - null, не помилка. @param {ProposalRow} row */
function shownPayload(row) {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

/** @param {Env} env @param {string} id @returns {Promise<ProposalRow | null>} */
async function loadRow(env, id) {
  const { results } = await db(env).prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
  return /** @type {ProposalRow | undefined} */ (results?.[0]) ?? null;
}

/** CAS open→status; true = саме ЦЕЙ виклик забрав рішення (changes === 1).
 *  @param {Env} env @param {string} id @param {string} status @param {number} nowMs */
async function setStatus(env, id, status, nowMs) {
  const res = await db(env)
    .prepare(`UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .bind(status, new Date(nowMs).toISOString(), id)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}
