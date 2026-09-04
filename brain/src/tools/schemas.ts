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
      'Дані Світанку за scope: briefing·jobs·progress·reminders·checkin·saved·news·settings - короткі зрізи; archive - холодні місячні/тижневі згортки і важелі; weekly - ВСЕ для тижневого звіту одним читанням (JSON до 50k, лише профіль звіту). period («30d», «12w», «тиждень») звужує сирі серії у weekly; cap - стеля символів відповіді.',
    args: z.object({
      scope: z.string().max(32),
      cap: z.number().optional(),
      period: z.string().max(16).optional(),
    }),
  }),
  tool({
    coreName: 'runs.query',
    description:
      'Телеметрія системи за період (типово тиждень; «30d», «місяць»): прогони за профілями (кількість, медіана і p90 тривалості, помилки, кроки), останні помилки, квоти місяця з лімітами. Для блоку СИСТЕМА звіту.',
    args: z.object({ period: z.string().max(16).optional() }),
  }),
  tool({
    coreName: 'calendar.read',
    description: 'Події календаря власника на days днів уперед (0 - лише сьогодні, максимум 7).',
    args: z.object({ days: z.number().min(0).max(7) }),
  }),
  tool({
    coreName: 'mail.search',
    description:
      'Пошук у пошті: q - запит Gmail, працюють оператори from:, subject:, newer_than:7d, has:attachment. Кілька слів шукаються РАЗОМ (AND), тож бери ключове слово («Steam»), а не фразу («лист від Steam»). До 10 листів: відправник, тема, дата, id для mail.read. Результат - зовнішній вміст.',
    args: z.object({ q: z.string().min(2).max(120) }),
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
      'Запропонувати дію назовні. kind - РІВНО одне з: calendar.event, calendar.update, calendar.delete, invite, drive.write, tasks.create, settings, contact, collection.export, records.delete, ideas.delete, wishes.delete, gemini.image, forget, data.export, gemini.video. payload - поля дії. Нічого не виконується без підтвердження власника; після ✅ ядро зробить запис саме.',
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
  // Ідеї (етап 3 PR-4, S-3-1…7). Номер ідеї для власника - те, що повертає
  // create («#12»); id приймає і номер, і повний id.
  tool({
    coreName: 'ideas.list',
    description:
      'Список ідей (до 10, свіжі першими): фільтри domain (svitanok·робота·побут·бізнес·інше) і status (нова·в аналізі·план готовий·погоджено·у роботі·зроблено·відкладено·відхилено); без status - усе, крім зробленого й відхиленого.',
    args: z.object({
      domain: z.string().max(16).optional(),
      status: z.string().max(16).optional(),
      limit: z.number().min(1).max(10).optional(),
    }),
  }),
  tool({
    coreName: 'ideas.search',
    description: 'Повнотекстовий пошук ідей за словами q (назва і тіло); до 10 результатів.',
    args: z.object({ q: z.string().min(2).max(120) }),
  }),
  tool({
    coreName: 'ideas.create',
    description:
      'Записати ідею: title (коротко), body_md (суть), domain визнач сам (svitanok - цей проєкт; робота; побут; бізнес; інше), priority 1-3 (типово 2), effort S|M|L якщо очевидно, tags, next_action. Відповідь містить number - так власник посилатиметься на ідею («ідея #12»). T0 з «↩».',
    args: z.object({
      title: z.string().min(1).max(200),
      body_md: z.string().max(20_000).optional(),
      domain: z.string().max(16).optional(),
      priority: z.number().min(1).max(3).optional(),
      effort: z.string().max(1).optional(),
      tags: z.array(z.string().max(32)).optional(),
      next_action: z.string().max(300).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'ideas.update',
    description:
      'Змінити ідею за id - РЯДКОМ: номер («12») або повний id. Будь-які з title, body_md, domain, status, priority, effort, next_action, tags, analysis_md, plan_md. Статуси: нова·в аналізі·план готовий·погоджено·у роботі·зроблено·відкладено·відхилено. «план у роботу» = status «у роботі»; «погоджую план» = «погоджено». T0 з «↩».',
    args: z.object({
      id: z.string().max(64),
      title: z.string().max(200).optional(),
      body_md: z.string().max(20_000).optional(),
      domain: z.string().max(16).optional(),
      status: z.string().max(16).optional(),
      priority: z.number().min(1).max(3).optional(),
      effort: z.string().max(1).optional(),
      next_action: z.string().max(300).optional(),
      tags: z.array(z.string().max(32)).optional(),
      analysis_md: z.string().max(20_000).optional(),
      plan_md: z.string().max(20_000).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'ideas.analyze',
    description:
      'Почати аналіз ідеї за id (рядком: «12» або повний id): mode=plan - ядро повертає ідею і ти САМ пишеш аналіз і план у цій відповіді, потім зберігаєш їх через ideas.update(analysis_md, plan_md, status="план готовий"); mode=code (аналіз по коду репозиторію) поки недоступний - етап 4. Якщо власник не сказав, який режим, спитай: «По коду чи лише план?».',
    args: z.object({ id: z.string().max(64), mode: z.string().max(8).optional() }),
    write: true,
  }),
  tool({
    coreName: 'ideas.delete',
    description:
      'Видалити ідею за id (рядком: «12» або повний id) разом з історією. Потребує ✅ власника (T1).',
    args: z.object({ id: z.string().max(64) }),
    write: true,
  }),
  // Колекції (етап 3 PR-5, S-N4-1…5). Схему пропонуй через ask, фільтри -
  // структурні (ядро компілює SQL само).
  tool({
    coreName: 'collections.list',
    description: 'Колекції власника: назва, опис, поля (назва/тип/варіанти), кількість записів.',
    args: z.object({}),
  }),
  tool({
    coreName: 'collections.create',
    description:
      'Створити колекцію: name, description, fields - список {name, type (text·number·date·bool·choice·url·money), required?, options? (для choice), currency? (для money), default?}, sort_by - поле сортування. Схему СПОЧАТКУ погодь з власником через ask. T0 з «↩».',
    args: z.object({
      name: z.string().min(1).max(64),
      description: z.string().max(500).optional(),
      fields: z.array(z.record(z.string(), z.unknown())),
      sort_by: z.string().max(64).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'collections.update',
    description:
      'Змінити колекцію (collection - назва або id): нова name, description, fields (повна схема), sort_by. Старі записи лишаються як є. T0 з «↩».',
    args: z.object({
      collection: z.string().max(64),
      name: z.string().max(64).optional(),
      description: z.string().max(500).optional(),
      fields: z.array(z.record(z.string(), z.unknown())).optional(),
      sort_by: z.string().max(64).optional(),
    }),
    write: true,
  }),
  tool({
    coreName: 'collections.delete',
    description:
      'Видалити колекцію з УСІМА записами. Це T2: ядро створить пропозицію зі словом-підтвердженням - назви його власнику; без слова нічого не станеться.',
    args: z.object({ collection: z.string().max(64) }),
    write: true,
  }),
  tool({
    coreName: 'records.create',
    description:
      'Додати запис у колекцію: collection - назва, data - {поле: значення} за схемою (імена полів - зі схеми; число/дата/так-ні ядро приведе саме). T0 з «↩».',
    args: z.object({
      collection: z.string().max(64),
      data: z.record(z.string(), z.unknown()),
    }),
    write: true,
  }),
  tool({
    coreName: 'records.update',
    description:
      'Змінити поля запису (id зі списку): data - лише ті поля, що змінюються. T0 з «↩».',
    args: z.object({
      collection: z.string().max(64),
      id: z.string().max(64),
      data: z.record(z.string(), z.unknown()),
    }),
    write: true,
  }),
  tool({
    coreName: 'records.list',
    description:
      'Записи колекції (≤ 20): where - список умов {field, op, value}, op одне з = != > >= < <= contains in empty not_empty (числа й дати порівнюються як значення); sort - поле, desc - за спаданням. «покажи Сервіси де ціна > 100» → where:[{field:"ціна_міс", op:">", value:100}].',
    args: z.object({
      collection: z.string().max(64),
      where: z.array(z.record(z.string(), z.unknown())).optional(),
      sort: z.string().max(64).optional(),
      desc: z.boolean().optional(),
      limit: z.number().min(1).max(20).optional(),
    }),
  }),
  tool({
    coreName: 'records.search',
    description: 'Повнотекстовий пошук по значеннях записів (усі колекції або одна); ≤ 20.',
    args: z.object({ q: z.string().min(2).max(120), collection: z.string().max(64).optional() }),
  }),
  tool({
    coreName: 'records.delete',
    description: 'Видалити один запис (id зі списку). Потребує ✅ власника (T1).',
    args: z.object({ collection: z.string().max(64), id: z.string().max(64) }),
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
