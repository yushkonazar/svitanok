// Zod-дзеркала інструментів ядра (07 §4). Джерело істини - web/core/tools/
// index.mjs (JSON-схеми): тест tests/brain-tool-parity.test.ts тримає обидва
// боки однаковими поведінково (required, типи, межі), тож розбіжність контракту
// червонить CI, а не спливає 400-ками в проді.
//
// mcpName: імена MCP-інструментів не містять крапок, тому 'data.read' на боці
// SDK живе як 'data_read'; у /internal/tool/:name іде coreName.

import { z } from 'zod';

export interface BrainToolDef {
  /** Канонічне імʼя ядра (07 §4) - шлях /internal/tool/:name. */
  coreName: string;
  /** Імʼя інструмента в MCP-сервері svitanok (без крапок). */
  mcpName: string;
  /** Опис для моделі. */
  description: string;
  args: z.ZodObject<z.ZodRawShape>;
  /** Результат - зовнішній вміст: ядро маркує <external> і ставить taint. */
  tainting: boolean;
  /** Write-інструмент: ядро виконує через policy (T0/T1), не напряму. */
  write: boolean;
  /** Внутрішній інструмент (07 §4 «(внутр.)»): виконавця в ядрі НЕМАЄ,
   *  роботу робить сам мозок - у /internal/tool такий виклик не йде. */
  internal: boolean;
}

function tool(def: {
  coreName: string;
  description: string;
  args: z.ZodObject<z.ZodRawShape>;
  tainting?: boolean;
  write?: boolean;
  internal?: boolean;
}): BrainToolDef {
  return {
    coreName: def.coreName,
    mcpName: def.coreName.replaceAll('.', '_'),
    description: def.description,
    args: def.args,
    tainting: def.tainting ?? false,
    write: def.write ?? false,
    internal: def.internal ?? false,
  };
}

export const BRAIN_TOOLS: readonly BrainToolDef[] = [
  tool({
    coreName: 'data.read',
    description:
      'Дані Світанку за scope (briefing·jobs·progress·reminders·checkin·saved·news·settings·archive·all); cap - стеля символів відповіді.',
    args: z.object({ scope: z.string().max(32), cap: z.number().optional() }),
  }),
  tool({
    coreName: 'calendar.read',
    description: 'Події календаря власника на days днів уперед (0 - лише сьогодні, максимум 7).',
    args: z.object({ days: z.number().min(0).max(7) }),
  }),
  tool({
    coreName: 'mail.search',
    description: 'Пошук у пошті за запитом q. Результат - зовнішній вміст.',
    args: z.object({ q: z.string().max(120) }),
    tainting: true,
  }),
  tool({
    coreName: 'mail.read',
    description: 'Прочитати лист за id з результату mail.search. Результат - зовнішній вміст.',
    args: z.object({ id: z.string().max(128) }),
    tainting: true,
  }),
  tool({
    coreName: 'drive.search',
    description: 'Пошук файлів у Drive за q: назви й посилання. Результат - зовнішній вміст.',
    args: z.object({ q: z.string().max(120) }),
    tainting: true,
  }),
  tool({
    coreName: 'geo.last',
    description: 'Остання відома локація власника та її вік.',
    args: z.object({}),
  }),
  tool({
    coreName: 'geo.geocode',
    description: 'Координати за текстом (місто або адреса).',
    args: z.object({ text: z.string().max(200) }),
  }),
  tool({
    coreName: 'memory.search',
    description:
      'Пошук у памʼяті минулих розмов (згортки з датами) за запитом q; limit - скільки цитат (1-10).',
    args: z.object({ q: z.string().max(200), limit: z.number().min(1).max(10).optional() }),
  }),
  tool({
    coreName: 'facts.get',
    description: 'Факти про власника; kind і key - необовʼязкові фільтри.',
    args: z.object({ kind: z.string().max(32).optional(), key: z.string().max(128).optional() }),
  }),
  // Нагадування (PR-6). `when` - природний текст («через 20 хв», «завтра о
  // 9»): час рахує ядро тим самим парсером, що обслуговує /remind, тож моделі
  // не треба знати ні київський зсув, ні переведення годинника.
  tool({
    coreName: 'reminders.create',
    description:
      'Створити нагадування. when - природний текст часу («через 20 хв», «завтра о 9»); text - про що нагадати (можна лишити порожнім, якщо зміст уже в when).',
    args: z.object({ when: z.string().max(120), text: z.string().max(200).optional() }),
    write: true,
  }),
  tool({
    coreName: 'reminders.update',
    description:
      'Змінити активне нагадування за id: новий текст і/або новий час (природним текстом). id бери зі списку нагадувань.',
    args: z.object({
      id: z.string().max(64),
      when: z.string().max(120).optional(),
      text: z.string().max(200).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'reminders.cancel',
    description: 'Скасувати активне нагадування за id зі списку.',
    args: z.object({ id: z.string().max(64) }),
    write: true,
  }),
  tool({
    coreName: 'record',
    description:
      'Записати локальну подію: kind = checkin | news-vote | job-stage | roadmap. payload: checkin - поля чек-іна; news-vote - {index}; job-stage - {index, stage}; roadmap - {topic_id, subtopic_id}. Позиції беруться зі списків, які щойно прочитав.',
    args: z.object({
      kind: z.string().max(16),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    write: true,
  }),
  // proposals.create: усе, що виходить ЗА МЕЖІ власного сховища, іде лише
  // так - і лише після ✅ власника (07 §4).
  tool({
    coreName: 'proposals.create',
    description:
      'Запропонувати дію назовні (календар, контакт, Drive, Tasks, налаштування, експорт): kind - вид дії, payload - її поля. Нічого не виконується без підтвердження власника; після ✅ ядро зробить запис саме.',
    args: z.object({
      kind: z.string().max(32),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'chain.start',
    description:
      'Почати багатокроковий ланцюг (столик, поїздка, відстеження ціни). Поки НЕ виконується: ланцюги приїдуть на етапі 5 - скажи власнику про це прямо, замість обхідних шляхів.',
    args: z.object({
      kind: z.string().max(32),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'facts.set',
    description:
      'Записати факт про власника (kind, key, value). Виконує ядро за policy: у чистій сесії - одразу з «↩», у tainted - як пропозиція.',
    args: z.object({
      kind: z.string().max(32),
      key: z.string().max(128),
      // Обовʼязковість без обмеження типу (ядро: required без properties-схеми).
      // JSON не має undefined, тож refine еквівалентний перевірці `'value' in args`.
      value: z.unknown().refine((v) => v !== undefined, 'бракує value'),
      source: z.string().max(16).optional(),
    }),
    write: true,
  }),
  // delegate - ВНУТРІШНІЙ інструмент (07 §4): у ядрі виконавця немає,
  // працівника запускає сам мозок окремим прогоном SDK. Імена - файли
  // docs/assistant/agents/<name>.md, бо саме вони стають промптом працівника;
  // персона знає їх під українськими назвами, тож перелік тут явний.
  tool({
    coreName: 'delegate',
    description:
      'Передати задачу працівнику: worker - імʼя (researcher·analyst·planner·day-planner·copywriter·editor·finance·mail-secretary·tutor), task - самодостатнє формулювання БЕЗ історії розмови (працівник її не бачить), format - який вигляд має мати результат.',
    args: z.object({
      worker: z.string().max(32),
      task: z.string().max(4000),
      format: z.string().max(200),
    }),
    internal: true,
  }),
];

export const TOOL_BY_CORE_NAME: ReadonlyMap<string, BrainToolDef> = new Map(
  BRAIN_TOOLS.map((t) => [t.coreName, t]),
);

export const TOOL_BY_MCP_NAME: ReadonlyMap<string, BrainToolDef> = new Map(
  BRAIN_TOOLS.map((t) => [t.mcpName, t]),
);
