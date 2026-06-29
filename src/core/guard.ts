// TS-обгортка над єдиним джерелом логіки guard (guard-core.mjs, §19.1).
// Оркестратор використовує саме її; CI — той самий guard-core через scripts/guard.mjs.
// Сюди приходить Clock — київську годину/дату бере звідти (DST-коректно, §19.11).

import { decideSend, type GuardDecision } from './guard-core.mjs';
import type { Clock } from './clock.js';

export type { GuardDecision } from './guard-core.mjs';

export interface SendGuardInput {
  sendHour: number;
  sendWindowHours: number;
  clock: Clock;
  lastSentDate: string | null;
  /** workflow_dispatch / CLI --force: обійти вікно та ідемпотентність (§19.2). */
  force?: boolean;
}

/** Рішення «слати чи ні» для поточного київського моменту. */
export function sendGuard(input: SendGuardInput): GuardDecision {
  const { sendHour, sendWindowHours, clock, lastSentDate, force = false } = input;
  return decideSend({
    sendHour,
    sendWindowHours,
    kyivHour: clock.kyivHour(),
    todayKey: clock.todayKey(),
    lastSentDate,
    force,
  });
}
