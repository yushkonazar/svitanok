import type { Field } from './catalog.mjs';
export interface ChoiceEntry {
  field: string;
  id: string;
  label: string;
  group: string;
  scope: string;
  deleted: boolean;
}
export interface ChoiceCatalog {
  version: 1;
  revision: number;
  entries: ChoiceEntry[];
  receipts: { id: string; signature: string }[];
}
export type PublicChoiceCatalog = Omit<ChoiceCatalog, 'receipts'>;
export interface ChoiceCommand {
  op: 'create' | 'update' | 'delete' | 'restore';
  requestId: string;
  expectedRevision: number;
  field: string;
  optionId: string;
  label?: string;
  group?: string;
  scope?: string;
}
export function normalizeChoiceCatalog(raw?: unknown): ChoiceCatalog;
export function publicChoiceCatalog(raw?: unknown): PublicChoiceCatalog;
export function editableChoiceField(field: Field): boolean;
export function editableChoiceValue(id: unknown): boolean;
export function choiceScopes(field: string): [string, string][];
export function activeChoiceScopes(field: string, answers: Record<string, unknown>): string[];
export function defaultChoiceScope(field: string, answers: Record<string, unknown>): string;
export function resolveFieldChoices(field: Field, raw?: unknown, scopes?: string[]): Field;
export function applyChoiceCommand(
  raw: unknown,
  command: ChoiceCommand | Record<string, unknown>,
  fields: Field[],
): ChoiceCatalog;
export function choiceAnswerLabel(
  field: Field,
  value: unknown,
  record?: Record<string, unknown>,
): string;
export function choiceLabelsForDays(
  days: {
    date?: string;
    morning?: Record<string, unknown>;
    afternoon?: Record<string, unknown>;
    evening?: Record<string, unknown>;
  }[],
  slot: string,
  field: Field,
): Record<string, string>;
export class ChoiceCatalogError extends Error {
  status: number;
  constructor(message: string, status?: number);
}
