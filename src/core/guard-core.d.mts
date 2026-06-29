// Типи для guard-core.mjs (щоб core/guard.ts і тести бачили строгий контракт).

export interface GuardParams {
  sendHour: number;
  sendWindowHours: number;
  kyivHour: number;
  todayKey: string;
  lastSentDate: string | null;
  force?: boolean;
}

export interface GuardDecision {
  send: boolean;
  reason: string;
}

export function decideSend(p: GuardParams): GuardDecision;
