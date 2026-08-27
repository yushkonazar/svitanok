// Парність інструментів мозок↔ядро (07 §4): набір імен, прапорці tainting і
// write, обовʼязковість полів - структурно; типи та межі (maxLength, minimum,
// maximum) - ПОВЕДІНКОВО, пробами, згенерованими з JSON-схем ядра. Так тест не
// залежить від нутрощів Zod і червоніє рівно тоді, коли валідатори реально
// розходяться в вироку на тому самому вході.

import { describe, expect, it } from 'vitest';
import { TOOLS } from '../web/core/tools/index.mjs';
import { validateAgainst } from '../web/core/internal/schemas.mjs';
import { BRAIN_TOOLS, TOOL_BY_CORE_NAME } from '../brain/src/tools/schemas.js';

type CoreSchema = (typeof TOOLS)[keyof typeof TOOLS]['args'];

/** Мінімальний валідний зразок значення за схемою поля. */
function sampleFor(schema: CoreSchema | undefined): unknown {
  if (!schema) return 'x';
  switch (schema.type) {
    case 'string':
      return 'x';
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
    expect(BRAIN_TOOLS.map((t) => t.coreName).sort()).toEqual(Object.keys(TOOLS).sort());
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
