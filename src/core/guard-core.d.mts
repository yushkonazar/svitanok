// Типи для guard-core.mjs (щоб core/guard.ts і тести бачили строгий контракт).

export interface GuardParams {
  sendHour: number;
  sendWindowHours: number;
  kyivHour: number;
  todayKey: string;
  lastSentDate: string | null;
  /** Обійти лише годинне вікно; ідемпотентність за добу лишається (B2). */
  forceWindow?: boolean;
  /** Обійти і вікно, і ідемпотентність — перезаписує сьогоднішній брифінг. */
  forceSend?: boolean;
  /** Легасі-синонім forceSend (старі виклики/тести). */
  force?: boolean;
}

export interface GuardDecision {
  send: boolean;
  reason: string;
}

export function decideSend(p: GuardParams): GuardDecision;
