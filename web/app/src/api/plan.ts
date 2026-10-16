import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inTelegram, tg } from '../telegram.ts';
import { SessionExpiredError } from './client.ts';

const nullableTime = z.string().nullable().optional();
const report = z.object({
  id: z.string(),
  units: z.number(),
  observedUnits: z.number(),
  actualAt: z.string(),
  recordedAt: z.string(),
  retracted: z.boolean(),
});
export const planTaskSchema = z.object({
  id: z.string(),
  date: z.string(),
  title: z.string(),
  criterion: z.string(),
  resultId: z.string(),
  xp: z.number(),
  target: z.number(),
  unit: z.string(),
  effort: z.number(),
  contribution: z.number(),
  challenge: z.number().optional(),
  area: z.string().optional(),
  routine: z.boolean().optional(),
  source: z
    .object({
      kind: z.literal('taxi'),
      metric: z.enum(['net', 'gross']),
      from: z.string(),
      until: z.string(),
      proof: nullableTime,
      actualMinor: z.number().optional(),
      checkedAt: nullableTime,
      warning: nullableTime,
    })
    .nullable()
    .optional(),
  deadlineKind: z.enum(['day', 'time', 'shift']),
  dueAt: z.string(),
  startAt: nullableTime,
  endAt: nullableTime,
  timeSensitive: z.boolean(),
  firstStep: z.string(),
  estimateMinutes: z.number(),
  goalId: nullableTime,
  rewardId: nullableTime,
  remindMinutes: z.number().nullable(),
  calendar: z.boolean(),
  calendarState: z.enum(['none', 'pending', 'synced', 'error', 'conflict']),
  calendarEventId: nullableTime,
  calendarOriginId: nullableTime,
  status: z.enum(['draft', 'accepted', 'excepted']),
  createdAt: z.string(),
  acceptedAt: nullableTime,
  settledAt: nullableTime,
  forfeitedAt: nullableTime,
  startedAt: nullableTime,
  penaltyPercent: z.number().optional(),
  penaltyXp: z.number().optional(),
  penaltyRequested: z.number().optional(),
  penaltyApplied: z.number().optional(),
  settleAfter: nullableTime,
  reportGraceHours: z.number().optional(),
  exceptionReason: z.string().optional(),
  fromTaskId: nullableTime,
  facts: z.object({
    units: z.number(),
    target: z.number(),
    credited: z.number(),
    onTimeUnits: z.number(),
    risk: z.number(),
    done: z.boolean(),
  }),
  lastReport: report.nullable(),
});
const reward = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string(),
  price: z.number(),
  scale: z.enum(['near', 'middle', 'large']),
  repeatable: z.boolean(),
  mode: z.enum(['spend', 'unlock']).optional(),
  purchase: z
    .object({ amountMinor: z.number(), bufferMinor: z.number(), horizonDays: z.number() })
    .nullable()
    .optional(),
  affordability: z
    .object({
      ready: z.boolean(),
      reason: z.string(),
      requiredMinor: z.number().optional(),
      currentSafeMinor: z.number().nullable().optional(),
      projectedMinor: z.number().nullable().optional(),
      checkedAt: z.string(),
    })
    .nullable()
    .optional(),
  archived: z.boolean(),
  gate: z
    .object({
      kind: z.enum(['milestone', 'purchase']),
      confirmed: z.boolean(),
      note: z.string(),
      checkedAt: nullableTime,
    })
    .nullable(),
});
export const planWorkspaceSchema = z.object({
  revision: z.number(),
  now: z.string(),
  today: z.string(),
  settings: z.object({
    enabled: z.boolean(),
    reviewedAt: nullableTime,
    penaltyPercent: z.number(),
    dayBoundary: z.string(),
    reportGraceHours: z.number(),
    eveningAt: z.string(),
  }),
  primaryRewardId: nullableTime,
  wallet: z.object({
    balance: z.number(),
    experience: z.number(),
    risk: z.number(),
    reserved: z.number(),
    available: z.number(),
  }),
  tasks: z.array(planTaskSchema),
  templates: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        days: z.array(z.number()),
        archived: z.boolean(),
        usedDates: z.array(z.string()).optional(),
        lastError: z.string().optional(),
        lastErrorDate: z.string().optional(),
      }),
    )
    .default([]),
  days: z
    .array(z.object({ id: z.string(), date: z.string(), until: z.string(), reason: z.string() }))
    .default([]),
  historyCursor: nullableTime,
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      why: z.string(),
      horizon: z.enum(['week', 'month']),
      dueDate: z.string(),
    }),
  ),
  rewards: z.array(reward),
  coupons: z.array(
    z.object({
      id: z.string(),
      rewardId: z.string(),
      title: z.string(),
      price: z.number(),
      status: z.enum(['ready', 'used', 'refunded', 'unlocked']),
      unlockXp: z.number().nullable().optional(),
      createdAt: z.string(),
    }),
  ),
  shifts: z.array(
    z.object({
      id: z.string(),
      date: z.string().optional(),
      startedAt: z.string(),
      reviewAt: z.string(),
      endedAt: nullableTime,
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      at: z.string(),
      delta: z.number(),
      experienceDelta: z.number(),
      balance: z.number(),
      taskId: z.string().optional(),
      reason: z.string().optional(),
      requested: z.number().optional(),
      applied: z.number().optional(),
    }),
  ),
  suggestions: z.array(z.object({ title: z.string(), price: z.number(), scale: z.string() })),
});
export type PlanWorkspace = z.infer<typeof planWorkspaceSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type PlanReward = z.infer<typeof reward>;
export type PlanCommand = {
  op: string;
  id?: string;
  payload: Record<string, unknown>;
  commandId: string;
  revision: number;
};
const key = ['motivation-plan'];
const pendingKey = 'svitanok:plan-pending:v1';
export function readPendingPlanCommand(): PlanCommand | null {
  if (!inTelegram()) return null;
  try {
    const saved = z
      .object({
        op: z.string(),
        id: z.string().optional(),
        payload: z.record(z.string(), z.unknown()),
        commandId: z.string(),
        revision: z.number(),
      })
      .safeParse(JSON.parse(localStorage.getItem(pendingKey) ?? 'null'));
    return saved.success ? saved.data : null;
  } catch {
    return null;
  }
}
function pendingCommand(command: PlanCommand | null) {
  try {
    if (command) localStorage.setItem(pendingKey, JSON.stringify(command));
    else localStorage.removeItem(pendingKey);
  } catch {
    /* the in-memory retry still works */
  }
}
const headers = (): Record<string, string> =>
  inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
export class PlanCommandError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function fetchPlan(): Promise<PlanWorkspace> {
  if (!inTelegram()) return (await import('./plan-demo.ts')).readPlanDemo();
  const response = await fetch('/api/plan', { cache: 'no-store', headers: headers() });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  if (!response.ok) throw new Error('Не вдалося завантажити план. Спробуй ще раз.');
  const parsed = planWorkspaceSchema.safeParse((await response.json())?.workspace);
  if (!parsed.success) throw new Error('Формат плану змінився. Онови застосунок.');
  return parsed.data;
}
export async function fetchPlanPage(cursor: string): Promise<PlanWorkspace> {
  if (!inTelegram()) return (await import('./plan-demo.ts')).readPlanDemo();
  const response = await fetch(`/api/plan?cursor=${encodeURIComponent(cursor)}`, {
    cache: 'no-store',
    headers: headers(),
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  if (!response.ok) throw new Error('Не вдалося завантажити попередні події.');
  return planWorkspaceSchema.parse((await response.json()).workspace);
}
const draftSchema = z.object({
  title: z.string(),
  criterion: z.string(),
  target: z.number(),
  unit: z.string(),
  area: z.string(),
  effort: z.number(),
  contribution: z.number(),
  challenge: z.number(),
  routine: z.boolean(),
  estimateMinutes: z.number(),
  firstStep: z.string(),
  dueTime: nullableTime,
  startTime: nullableTime,
  timeSensitive: z.boolean(),
  source: z.enum(['taxi-net', 'taxi-gross']).nullable(),
  questions: z.array(z.string()),
  xp: z.number(),
});
export type TaskDraftSuggestion = z.infer<typeof draftSchema>;
export async function suggestPlanTask(text: string, date: string): Promise<TaskDraftSuggestion> {
  if (!inTelegram())
    throw new Error(
      'Заповнення асистентом працює у твоїй Telegram-сесії. У демо доступна ручна форма.',
    );
  const response = await fetch('/api/plan', {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'suggest', payload: { text, date } }),
    signal: AbortSignal.timeout(25000),
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Не вдалося підготувати підказку.');
  return draftSchema.parse(body.draft);
}
export const planCalendarEvent = z.object({
  id: nullableTime,
  title: z.string(),
  time: nullableTime,
  date: nullableTime,
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  transparent: z.boolean(),
});
export type PlanCalendarEvent = z.infer<typeof planCalendarEvent>;
export async function fetchPlanCalendar(date: string): Promise<PlanCalendarEvent[]> {
  if (!inTelegram()) throw new Error('Google Calendar доступний у твоїй Telegram-сесії.');
  const response = await fetch(`/api/plan?view=calendar&date=${date}`, {
    cache: 'no-store',
    headers: headers(),
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Календар недоступний.');
  return z.array(planCalendarEvent).parse(body.events);
}
export async function changePlan(command: PlanCommand): Promise<{
  receipt: { message: string; id: string; reportId: string };
  workspace: PlanWorkspace | null;
}> {
  if (!inTelegram()) return (await import('./plan-demo.ts')).changePlanDemo(command);
  pendingCommand(command);
  let response: Response;
  try {
    response = await fetch('/api/plan', {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new PlanCommandError('Зв’язок перервався. Перевір останній запис перед новою дією.', 503);
  }
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  const body = await response.json().catch(() => null);
  if ((response.status >= 400 && response.status < 500) || body?.ok === true) pendingCommand(null);
  if (!response.ok || !body?.ok)
    throw new PlanCommandError(
      typeof body?.error === 'string'
        ? body.error
        : 'Не отримав підтвердження. Онови план перед повтором.',
      response.status,
    );
  const receipt = z
    .object({ message: z.string(), id: z.string(), reportId: z.string() })
    .parse(body.receipt);
  const workspace = planWorkspaceSchema.safeParse(body.workspace);
  return { receipt, workspace: workspace.success ? workspace.data : null };
}
export function usePlan() {
  return useQuery({
    queryKey: key,
    queryFn: fetchPlan,
    staleTime: 15000,
    refetchInterval: 60000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}
export function usePlanChange() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: changePlan,
    onSuccess: ({ workspace }) => {
      if (workspace) cache.setQueryData(key, workspace);
      else void cache.invalidateQueries({ queryKey: key });
    },
    onError: () => void cache.invalidateQueries({ queryKey: key }),
    retry: false,
  });
}
