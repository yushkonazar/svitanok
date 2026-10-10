import { z } from 'zod';
import { inTelegram, tg } from '../telegram.ts';
import { factDataSchema, stoicDataSchema } from './briefing-schema.ts';
import { throwIfSessionExpired } from './client.ts';
import { CONTENT_TOPICS } from '../../../core/brief/daily-content.mjs';

const profileSchema = z.object({
  date: z.string(),
  preferences: z.object({ topics: z.array(z.string()) }),
  feedback: z.record(z.string(), z.string()),
  status: z.object({ state: z.string() }).nullable().optional(),
});
const archiveSchema = z.object({
  items: z.array(
    z.object({
      date: z.string(),
      fact: factDataSchema.nullable(),
      quote: stoicDataSchema.nullable(),
    }),
  ),
  next: z.string().nullable(),
});
export type ContentProfile = z.infer<typeof profileSchema>;
export type ContentAction =
  | {
      type: 'feedback';
      kind: 'fact' | 'quote';
      id: string;
      date: string;
      signal: 'like' | 'less' | 'clear';
    }
  | { type: 'preferences'; preferences: { topics: string[] } };
const headers = () => ({
  'Content-Type': 'application/json',
  ...(tg?.initData ? { 'X-Telegram-Init-Data': tg.initData } : {}),
});
const demoKey = 'svitanok:daily-content:v1';
function demoProfile(): ContentProfile {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  try {
    return profileSchema.parse({ ...JSON.parse(localStorage.getItem(demoKey) ?? '{}'), date });
  } catch {
    return { date, preferences: { topics: Object.keys(CONTENT_TOPICS) }, feedback: {} };
  }
}
export async function fetchContentProfile() {
  if (!inTelegram()) return demoProfile();
  const res = await fetch('/api/daily-content', { headers: headers() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося завантажити вподобання');
  return profileSchema.parse(await res.json());
}
export async function postContentAction(action: ContentAction) {
  if (!inTelegram()) {
    const profile = demoProfile();
    if (action.type === 'preferences') profile.preferences = action.preferences;
    else profile.feedback[`${action.kind}:${action.id}`] = action.signal;
    localStorage.setItem(demoKey, JSON.stringify(profile));
    return;
  }
  const res = await fetch('/api/daily-content', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(action),
  });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося зберегти. Спробуй ще раз.');
}
export async function fetchContentArchive(before: string | null) {
  if (!inTelegram()) return { items: [], next: null } as z.infer<typeof archiveSchema>;
  const res = await fetch(
    `/api/daily-content?archive=1${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    { headers: headers() },
  );
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Архів тимчасово недоступний');
  return archiveSchema.parse(await res.json());
}
