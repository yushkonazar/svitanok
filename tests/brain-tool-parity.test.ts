// Парність інструментів мозок↔ядро (07 §4): набір імен, прапорці tainting і
// write, обовʼязковість полів - структурно; типи та межі (maxLength, minimum,
// maximum) - ПОВЕДІНКОВО, пробами, згенерованими з JSON-схем ядра. Так тест не
// залежить від нутрощів Zod і червоніє рівно тоді, коли валідатори реально
// розходяться в вироку на тому самому вході.

import { describe, expect, it } from 'vitest';
import { TOOLS } from '../web/core/tools/index.mjs';
import { DELIVER_SCHEMA, STATUS_SCHEMA, validateAgainst } from '../web/core/internal/schemas.mjs';
import { MAX_INTERNAL_BODY_BYTES } from '../web/core/internal/router.mjs';
import { BRAIN_TOOLS, TOOL_BY_CORE_NAME } from '../brain/src/tools/schemas.js';
import {
  DELIVER_MAX_BYTES,
  DELIVER_MAX_CHARS,
  DELIVER_WORKER_MAX_CHARS,
  STATUS_MAX_CHARS,
} from '../brain/src/agent.js';

type CoreSchema = (typeof TOOLS)[keyof typeof TOOLS]['args'];

/** Мінімальний валідний зразок значення за схемою поля. */
function sampleFor(schema: CoreSchema | undefined): unknown {
  if (!schema) return 'x';
  switch (schema.type) {
    case 'string':
      // Нижню межу теж поважаємо: у mail.search q мусить бути змістовним.
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    default:
      return {};
  }
}

/** Мінімальний валідний обʼєкт args за схемою ядра. */
function minimalArgs(schema: CoreSchema): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    args[key] = sampleFor(schema.properties?.[key]);
  }
  return args;
}

describe('парність інструментів мозок↔ядро', () => {
  it('набори імен збігаються', () => {
    const routed = BRAIN_TOOLS.filter((t) => !t.internal);
    expect(routed.map((t) => t.coreName).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  // Внутрішній інструмент (07 §4 «(внутр.)») виконує мозок, і виконавця в
  // ядрі в нього НЕ повинно бути: зʼявиться однойменний - виклик поїде в
  // /internal/tool повз мозок, тихо змінивши те, ЩО робить delegate.
  it('внутрішні інструменти не мають виконавця в ядрі', () => {
    const internal = BRAIN_TOOLS.filter((t) => t.internal);
    expect(internal.map((t) => t.coreName)).toEqual(['delegate']);
    for (const t of internal) expect(TOOLS[t.coreName as keyof typeof TOOLS]).toBeUndefined();
  });

  it('mcpName без крапок і без колізій', () => {
    const names = BRAIN_TOOLS.map((t) => t.mcpName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  for (const [coreName, core] of Object.entries(TOOLS)) {
    describe(coreName, () => {
      const brain = TOOL_BY_CORE_NAME.get(coreName);
      if (!brain) throw new Error(`немає дзеркала для ${coreName}`);
      const coreOk = (args: unknown) => validateAgainst(core.args, args).ok;
      const brainOk = (args: unknown) => brain.args.safeParse(args).success;

      it('прапорці tainting і write збігаються', () => {
        // ⚠️ У ядра `tainting` може бути ФУНКЦІЄЮ від аргументів (data.search:
        // місця й покупки - чужий текст, власні ідеї - ні). Мозку в описі
        // лишається консервативне «так»: модель має знати, що виклик МОЖЕ
        // заплямувати сесію. Тому тут порівнюємо «плямує взагалі», а точний
        // випадок перевіряє tests/tools-read.test.ts.
        expect(brain.tainting).toBe(Boolean(core.tainting));
        expect(brain.write).toBe(Boolean(core.write));
      });

      it('ключі властивостей збігаються', () => {
        const coreKeys = new Set([
          ...Object.keys(core.args.properties ?? {}),
          ...(core.args.required ?? []),
        ]);
        expect(new Set(Object.keys(brain.args.shape))).toEqual(coreKeys);
      });

      it('мінімальний валідний обʼєкт приймають обидва', () => {
        const args = minimalArgs(core.args);
        expect(coreOk(args)).toBe(true);
        expect(brainOk(args)).toBe(true);
      });

      for (const key of core.args.required ?? []) {
        it(`без обовʼязкового "${key}" відкидають обидва`, () => {
          const args = minimalArgs(core.args);
          delete args[key];
          expect(coreOk(args)).toBe(false);
          expect(brainOk(args)).toBe(false);
        });
      }

      for (const [key, prop] of Object.entries(core.args.properties ?? {})) {
        const maxLength = prop.type === 'string' ? prop.maxLength : undefined;
        if (maxLength != null) {
          it(`"${key}" довжиною ${maxLength} проходить, +1 - ні (в обох)`, () => {
            const base = minimalArgs(core.args);
            const atLimit = { ...base, [key]: 'а'.repeat(maxLength) };
            const overLimit = { ...base, [key]: 'а'.repeat(maxLength + 1) };
            expect(coreOk(atLimit)).toBe(true);
            expect(brainOk(atLimit)).toBe(true);
            expect(coreOk(overLimit)).toBe(false);
            expect(brainOk(overLimit)).toBe(false);
          });
        }
        const minLength = prop.type === 'string' ? prop.minLength : undefined;
        if (minLength != null && minLength > 1) {
          it(`"${key}" коротший за ${minLength} відкидають обидва`, () => {
            const base = minimalArgs(core.args);
            const tooShort = { ...base, [key]: 'а'.repeat(minLength - 1) };
            expect(coreOk(tooShort)).toBe(false);
            expect(brainOk(tooShort)).toBe(false);
          });
        }
        if (prop.type === 'number') {
          it(`"${key}" поза межами відкидають обидва`, () => {
            const base = minimalArgs(core.args);
            if (prop.minimum != null) {
              const below = { ...base, [key]: prop.minimum - 1 };
              expect(coreOk(below)).toBe(false);
              expect(brainOk(below)).toBe(false);
            }
            if (prop.maximum != null) {
              const above = { ...base, [key]: prop.maximum + 1 };
              expect(coreOk(above)).toBe(false);
              expect(brainOk(above)).toBe(false);
            }
            const wrongType = { ...base, [key]: 'не число' };
            expect(coreOk(wrongType)).toBe(false);
            expect(brainOk(wrongType)).toBe(false);
          });
        }
        if (prop.type === 'string') {
          it(`"${key}" не-рядок відкидають обидва`, () => {
            const args = { ...minimalArgs(core.args), [key]: 42 };
            expect(coreOk(args)).toBe(false);
            expect(brainOk(args)).toBe(false);
          });
        }
      }
    });
  }
});

describe('парність стель deliver/status мозок↔ядро', () => {
  it('символьні стелі мозку (+1 на «…») влазять у maxLength контрактів ядра', () => {
    expect(DELIVER_MAX_CHARS + 1).toBeLessThanOrEqual(
      DELIVER_SCHEMA.properties?.text?.maxLength ?? 0,
    );
    expect(STATUS_MAX_CHARS + 1).toBeLessThanOrEqual(
      STATUS_SCHEMA.properties?.text?.maxLength ?? 0,
    );
  });

  it('байтова стеля deliver лишає кап тіла ядра із запасом на обгортку й екранування', () => {
    // 4 KiB запасу: JSON-обгортка {"text":""} - 11 байт, екранування \n і лапок
    // додає ≤1 байта на символ лише для й так 1-байтових знаків.
    expect(DELIVER_MAX_BYTES + 4096).toBeLessThanOrEqual(MAX_INTERNAL_BODY_BYTES);
  });

  // Етап 4: текст працівника їде в тому ж тілі deliver; мозок ріже його під
  // maxLength ядра (+1 на «…»), а deliver-текст - з резервом на його байти.
  it('стеля тексту працівника мозку (+1 на «…») влазить у DELIVER_SCHEMA.worker.text', () => {
    expect(DELIVER_WORKER_MAX_CHARS + 1).toBeLessThanOrEqual(
      DELIVER_SCHEMA.properties?.worker?.properties?.text?.maxLength ?? 0,
    );
  });
});
