// Стадії воронки вакансій (дизайн v2, Svitanok.dc.html; воронка v2 — роадмеп F1).
//
// Дзеркало STAGES зі web/stats-core.mjs. ЛІНІЙНІ — шлях уперед; ТЕРМІНАЛЬНІ
// (rejected/failed) — вихід із воронки, тому вони поза прогресом: не «далі», а
// «закінчилось». Конверсії рахує сервер із журналу переходів, тож термінальна
// стадія не викидає вакансію зі знаменника.
//
// ⚠️ Список має збігатися з бекендом: незнану стадію stats-core трактує як
// stage:null і ВИДАЛЯЄ вакансію з воронки.

export type LinearStage = 'saved' | 'applied' | 'interview' | 'offer';
export type TerminalStage = 'rejected' | 'failed';
export type FunnelStage = LinearStage | TerminalStage;

export const TERMINAL_STAGES: readonly TerminalStage[] = ['rejected', 'failed'];
export const isTerminal = (s: FunnelStage): s is TerminalStage =>
  (TERMINAL_STAGES as readonly string[]).includes(s);

/** Стадії для швидкого тріажу свіжої вакансії в «Списку» (JobCard) — фідбек
 *  власника: interview/offer/rejected/failed переводяться пізніше вручну в
 *  Канбані, де видно контекст, а не одним тапом на щойно збереженій картці. */
export const TRIAGE_STAGES: readonly FunnelStage[] = ['saved', 'applied'];

export const FUNNEL_STAGES: { key: FunnelStage; label: string; short: string }[] = [
  { key: 'saved', label: 'Збережено', short: 'Збережено' },
  { key: 'applied', label: 'Подав', short: 'Подав' },
  { key: 'interview', label: 'Співбесіда', short: 'Співбесіда' },
  { key: 'offer', label: 'Офер', short: 'Офер' },
  { key: 'rejected', label: 'Відмова', short: 'Відмова' },
  { key: 'failed', label: 'Провал', short: 'Провал' },
];

/** Короткі підписи для віджета воронки (макет: «Співбес.»). */
export const FUNNEL_SHORT: Record<FunnelStage, string> = {
  saved: 'Збережено',
  applied: 'Подав',
  interview: 'Співбес.',
  offer: 'Офер',
  rejected: 'Відмова',
  failed: 'Провал',
};

export const STAGE_LABEL: Record<FunnelStage, string> = {
  saved: 'Збережено',
  applied: 'Подав',
  interview: 'Співбесіда',
  offer: 'Офер',
  rejected: 'Відмова',
  failed: 'Провал співбесіди',
};

/** Колір/тло/рамка ранжування заголовка — не fit повної вакансії. */
export function fitStyle(score: number): { tx: string; bg: string; brd: string; label: string } {
  if (score < 0)
    return {
      tx: 'var(--color-tx2)',
      bg: 'var(--color-glass)',
      brd: 'var(--color-glassb)',
      label: 'оцінюється',
    };
  if (score >= 85)
    return {
      tx: 'var(--color-pos)',
      bg: 'rgba(120,220,160,.14)',
      brd: 'var(--color-pos)',
      label: `${score}% заголовок`,
    };
  if (score >= 70)
    return {
      tx: 'var(--color-a2)',
      bg: 'rgba(255,164,92,.14)',
      brd: 'rgba(255,164,92,.4)',
      label: `${score}% заголовок`,
    };
  return {
    tx: 'var(--color-tx2)',
    bg: 'var(--color-glass)',
    brd: 'var(--color-glassb)',
    label: `${score}% заголовок`,
  };
}
