import { z } from 'zod';
import { savedItemSchema, type SavedItem } from './schema.ts';
import { SAMPLE_SAVED_ARCHIVE } from './sample.ts';
import { kyivParts } from '../../../core/finance/planning.mjs';
const KEY = 'svitanok:saved-demo:v1';
export function readSavedDemo(): SavedItem[] {
  try {
    const parsed = z
      .array(savedItemSchema)
      .safeParse(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    if (parsed.success) return parsed.data.slice(0, 1000);
  } catch {
    /* Use examples. */
  }
  return [...SAMPLE_SAVED_ARCHIVE];
}
export function writeSavedDemo(type: string, p: Record<string, unknown>) {
  const kind = type.endsWith('news') ? 'news' : String(p.kind ?? ''),
    id = String(kind === 'news' ? p.url : p.id);
  if (!kind || !id || id === 'undefined') return;
  const items = readSavedDemo().filter((v) => v.kind !== kind || v.id !== id);
  if (type.startsWith('save_'))
    items.unshift({
      kind,
      id,
      title: String(p.title ?? '').slice(0, 2000),
      url: kind === 'news' ? id : null,
      ts: kyivParts(Date.now()).date,
    });
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, 1000)));
  } catch {
    /* Storage can be unavailable. */
  }
}
