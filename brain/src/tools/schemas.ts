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
}

function tool(def: {
  coreName: string;
  description: string;
  args: z.ZodObject<z.ZodRawShape>;
  tainting?: boolean;
  write?: boolean;
}): BrainToolDef {
  return {
    coreName: def.coreName,
    mcpName: def.coreName.replaceAll('.', '_'),
    description: def.description,
    args: def.args,
    tainting: def.tainting ?? false,
    write: def.write ?? false,
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
    coreName: 'facts.get',
    description: 'Факти про власника; kind і key - необовʼязкові фільтри.',
    args: z.object({ kind: z.string().max(32).optional(), key: z.string().max(128).optional() }),
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
];

export const TOOL_BY_CORE_NAME: ReadonlyMap<string, BrainToolDef> = new Map(
  BRAIN_TOOLS.map((t) => [t.coreName, t]),
);

export const TOOL_BY_MCP_NAME: ReadonlyMap<string, BrainToolDef> = new Map(
  BRAIN_TOOLS.map((t) => [t.mcpName, t]),
);
