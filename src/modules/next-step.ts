// next-step (consumer, §6). Ротація кроків «до офера» зі списку config; індекс у
// state. При правці списку межі валідуються (index % steps.length, безпечно й
// для від'ємних). Показані кроки логуються для weekly-review (retention 7 днів).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

export interface NextStepLogEntry {
  step: string;
  date: string; // YYYY-MM-DD
}

/** Безпечний індекс у межах [0, len) навіть для зсунутого/від'ємного state. */
export function safeIndex(idx: number, len: number): number {
  return ((Math.trunc(idx) % len) + len) % len;
}

export const nextStepModule: Module<AppConfig> = {
  id: 'next-step',
  kind: 'consumer',
  enabled: (config) => config.modules.nextStep.enabled,
  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const steps = ctx.config.modules.nextStep.steps;
    if (!steps || steps.length === 0) return null;

    const stored = ctx.state.get<number>('nextStepIndex') ?? 0;
    const i = safeIndex(stored, steps.length);
    const step = steps[i]!;

    // Наступного разу — наступний крок.
    ctx.state.set('nextStepIndex', i + 1);

    // Лог для weekly-review.
    const today = ctx.clock.todayKey();
    const log = ctx.state.get<NextStepLogEntry[]>('nextStepLog') ?? [];
    ctx.state.set('nextStepLog', [...log, { step, date: today }]);

    return {
      id: 'next-step',
      title: 'Крок до офера',
      icon: '🎯',
      summary: step,
      data: { step },
      priority: 60,
    };
  },
};
