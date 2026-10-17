import { z } from 'zod';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { inTelegram, tg } from '../telegram.ts';
import { SessionExpiredError } from './client.ts';

export const BOOKMARK_QUERY = ['idea-bookmarks'] as const;
const nullable = z.string().nullable();
export const bookmarkSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  status: z.string(),
  priority: z.number(),
  area: z.string(),
  kind: z.string(),
  version: z.string(),
  sourceHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  analysis: nullable.optional(),
  plan: nullable.optional(),
});
export const ideaBriefSchema = z.object({
  title: z.string(),
  problem: z.string(),
  outcome: z.string(),
  userFlow: z.array(z.string()),
  minimumScope: z.array(z.string()),
  futureScope: z.array(z.string()),
  integrations: z.array(z.string()),
  implementation: z.array(z.string()),
  acceptance: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(z.string()),
});
export const formulationSchema = z.object({
  id: z.string(),
  ideaId: z.string(),
  sourceHash: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  contextVersion: nullable,
  createdAt: z.string(),
  finishedAt: nullable,
  error: nullable,
  revision: z.number(),
  published: z.boolean(),
  result: ideaBriefSchema.nullable(),
  source: z.object({ title: z.string(), body: z.string() }),
  prompt: nullable,
  customPrompt: z.boolean(),
});
const detailSchema = z.object({
  item: bookmarkSchema,
  formulations: z.array(formulationSchema),
  historyCursor: nullable,
});
const listSchema = z.object({
  items: z.array(bookmarkSchema),
  cursor: nullable,
  context: z.string(),
});
export type Bookmark = z.infer<typeof bookmarkSchema>;
export type IdeaBrief = z.infer<typeof ideaBriefSchema>;
export type Formulation = z.infer<typeof formulationSchema>;
export type BookmarkDetail = z.infer<typeof detailSchema>;
export type BookmarkList = z.infer<typeof listSchema>;
export interface BookmarkCommand {
  op: string;
  commandId: string;
  id?: string;
  version?: string;
  payload: Record<string, unknown>;
}
const commandSchema = z.object({
  op: z.enum(['create', 'edit', 'status', 'formulate', 'save-prompt']),
  commandId: z.string(),
  id: z.string().optional(),
  version: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
const pendingKey = 'svitanok:bookmarks:pending:v1';
export function readPendingBookmark(): BookmarkCommand | null {
  try {
    const c = commandSchema.safeParse(JSON.parse(localStorage.getItem(pendingKey) ?? 'null'));
    return c.success ? c.data : null;
  } catch {
    return null;
  }
}
function pending(command: BookmarkCommand | null) {
  try {
    if (command) localStorage.setItem(pendingKey, JSON.stringify(command));
    else localStorage.removeItem(pendingKey);
  } catch {
    /* An open form still retains the owner text. */
  }
}
export class BookmarkCommandError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const headers = (): Record<string, string> =>
  inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
async function read(path: string) {
  const response = await fetch('/api/bookmarks' + path, { headers: headers(), cache: 'no-store' });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  const body = await response.json();
  if (!response.ok)
    throw new BookmarkCommandError(
      body.error ?? 'Не вдалося завантажити закладки.',
      response.status,
    );
  return body;
}
export async function fetchBookmarks(
  q = '',
  status = 'active',
  cursor?: string,
): Promise<BookmarkList> {
  if (!inTelegram())
    return (await import('./bookmarks-demo.ts')).readBookmarkDemoList(q, status, cursor);
  const params = new URLSearchParams({ q, status, ...(cursor ? { cursor } : {}) });
  return listSchema.parse(await read('?' + params));
}
export async function fetchBookmark(id: string, before?: string): Promise<BookmarkDetail> {
  if (!inTelegram()) return (await import('./bookmarks-demo.ts')).readBookmarkDemo(id, before);
  return detailSchema.parse(
    await read('?' + new URLSearchParams({ id, ...(before ? { before } : {}) })),
  );
}
export async function changeBookmark(command: BookmarkCommand) {
  if (!inTelegram()) return (await import('./bookmarks-demo.ts')).changeBookmarkDemo(command);
  const previous = readPendingBookmark();
  const same =
    previous &&
    previous.commandId === command.commandId &&
    previous.op === command.op &&
    previous.id === command.id &&
    previous.version === command.version &&
    JSON.stringify(Object.entries(previous.payload).sort()) ===
      JSON.stringify(Object.entries(command.payload).sort());
  if (previous && !same)
    throw new BookmarkCommandError('Спершу перевір попередній непідтверджений запис.', 409);
  pending(command);
  let response;
  try {
    response = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new BookmarkCommandError(
      'Підтвердження не надійшло. Текст збережений на пристрої; перевір ту саму спробу.',
      503,
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status < 500) pending(null);
    throw new BookmarkCommandError(
      body?.error ?? 'Не отримав підтвердження запису.',
      response.status,
    );
  }
  if (body?.ok !== true)
    throw new BookmarkCommandError('Не отримав підтвердження запису. Перевір ту саму спробу.', 503);
  const receipt = z
    .object({ id: z.string(), message: z.string(), formulationId: nullable })
    .safeParse(body.receipt);
  if (!receipt.success) throw new BookmarkCommandError('Не отримав підтвердження запису.', 503);
  pending(null);
  const detail = detailSchema.safeParse(body);
  return { receipt: receipt.data, detail: detail.success ? detail.data : null };
}
export function useBookmarks(q: string, status: string) {
  return useInfiniteQuery({
    queryKey: [...BOOKMARK_QUERY, 'list', q, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchBookmarks(q, status, pageParam),
    getNextPageParam: (last) => last.cursor ?? undefined,
    staleTime: 15000,
    refetchOnMount: 'always',
  });
}
export function useBookmark(id: string | null) {
  return useQuery({
    queryKey: [...BOOKMARK_QUERY, 'detail', id],
    queryFn: () => fetchBookmark(id!),
    enabled: Boolean(id),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      query.state.data?.formulations.some((r) => r.status === 'queued' || r.status === 'running')
        ? 2000
        : false,
  });
}
export function useBookmarkChange() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: changeBookmark,
    retry: false,
    onSuccess: (result) => {
      if (result.detail)
        cache.setQueryData([...BOOKMARK_QUERY, 'detail', result.receipt.id], result.detail);
      void cache.invalidateQueries({ queryKey: [...BOOKMARK_QUERY, 'list'] });
      if (!result.detail)
        void cache.invalidateQueries({
          queryKey: [...BOOKMARK_QUERY, 'detail', result.receipt.id],
        });
    },
    onError: () => void cache.invalidateQueries({ queryKey: BOOKMARK_QUERY }),
  });
}
