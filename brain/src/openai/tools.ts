// Перетворення canonical Zod-реєстру на strict Responses function tools.
// Виконання тут навмисно відсутнє: OpenAI лише просить виклик, а agent.ts
// повертає його в Cloudflare core через onToolCall.

import { z } from 'zod';
import { BRAIN_TOOLS, type BrainToolDef } from '../tools/schemas.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface OpenAiFunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: JsonObject;
  /** Для dynamic record-аргументів модель передає один JSON-рядок. */
  encodedArguments: boolean;
}

export function openAiFunctionTools(toolNames: string[]): OpenAiFunctionTool[] {
  return BRAIN_TOOLS.filter((tool) => toolNames.includes(tool.mcpName)).map(openAiFunctionTool);
}

export function openAiFunctionTool(definition: BrainToolDef): OpenAiFunctionTool {
  const schema = z.toJSONSchema(definition.args) as JsonObject;
  if (hasDynamicObject(schema)) {
    return {
      type: 'function',
      name: definition.mcpName,
      description: `${definition.description}\n\nПередай аргументи цього інструмента як JSON-обʼєкт у arguments_json.`,
      strict: true,
      encodedArguments: true,
      parameters: {
        type: 'object',
        properties: { arguments_json: { type: 'string' } },
        required: ['arguments_json'],
        additionalProperties: false,
      },
    };
  }
  return {
    type: 'function',
    name: definition.mcpName,
    description: definition.description,
    strict: true,
    encodedArguments: false,
    parameters: strictSchema(schema),
  };
}

/** Відповідь strict schema робить optional поля nullable; ядро очікує absent. */
export function decodeOpenAiArguments(raw: string, encodedArguments: boolean): unknown {
  const parsed: unknown = JSON.parse(raw);
  const value = encodedArguments
    ? isObject(parsed) && typeof parsed.arguments_json === 'string'
      ? JSON.parse(parsed.arguments_json)
      : invalidEncodedArguments()
    : parsed;
  return stripOptionalNulls(value);
}

function invalidEncodedArguments(): never {
  throw new Error('arguments_json відсутній або не є JSON-рядком');
}

function hasDynamicObject(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasDynamicObject);
  if (!isObject(value)) return false;
  // z.unknown() becomes `{}` in JSON Schema. OpenAI strict function
  // parameters require a concrete schema at every property, so preserve an
  // unconstrained owner value through the existing JSON-string envelope.
  if (Object.keys(value).length === 0) return true;
  const objectLike = value.type === 'object' || 'properties' in value;
  if (objectLike && value.additionalProperties !== false && !('properties' in value)) return true;
  return Object.values(value).some(hasDynamicObject);
}

function strictSchema(value: Json): JsonObject {
  const converted = strictify(value);
  if (!isObject(converted)) throw new Error('tool parameters must be an object');
  return converted;
}

function strictify(value: Json): Json {
  if (Array.isArray(value)) return value.map(strictify);
  if (!isObject(value)) return value;
  const out: JsonObject = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .map(([key, child]) => [key, strictify(child)]),
  );
  if (out.type === 'object' || isObject(out.properties)) {
    const properties = isObject(out.properties) ? out.properties : {};
    const priorRequired = new Set(
      Array.isArray(out.required)
        ? out.required.filter((name): name is string => typeof name === 'string')
        : [],
    );
    const names = Object.keys(properties);
    out.properties = Object.fromEntries(
      names.map((name) => {
        const property = properties[name] ?? {};
        return [name, priorRequired.has(name) ? property : nullable(property)];
      }),
    );
    out.required = names;
    out.additionalProperties = false;
  }
  return out;
}

function nullable(value: Json | undefined): Json {
  if (isObject(value) && typeof value.type === 'string') {
    return Object.assign({}, value, { type: [value.type, 'null'] }) as JsonObject;
  }
  return { anyOf: [value ?? {}, { type: 'null' }] };
}

function stripOptionalNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOptionalNulls);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, stripOptionalNulls(child)]),
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
