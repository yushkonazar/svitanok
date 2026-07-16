// Стадії воронки вакансій (дизайн v2, Svitanok.dc.html).
// Бекенд (stats-core) знає 4 персистентні стадії; «Відхилити» — ефемерна дія
// (job_dismiss), не стадія. Термінальні rejected/failed із макета потребують
// зміни stats-core — окремий крок (воронка v2 + канбан).

export type FunnelStage = 'saved' | 'applied' | 'interview' | 'offer';

export const FUNNEL_STAGES: { key: FunnelStage; label: string; short: string }[] = [
  { key: 'saved', label: 'Збережено', short: 'Збережено' },
  { key: 'applied', label: 'Подав', short: 'Подав' },
  { key: 'interview', label: 'Співбесіда', short: 'Співбесіда' },
  { key: 'offer', label: 'Офер', short: 'Офер' },
];

/** Короткі підписи для віджета воронки (макет: «Співбес.»). */
export const FUNNEL_SHORT: Record<FunnelStage, string> = {
  saved: 'Збережено',
  applied: 'Подав',
  interview: 'Співбес.',
  offer: 'Офер',
};

export const STAGE_LABEL: Record<FunnelStage, string> = {
  saved: 'Збережено',
  applied: 'Подав',
  interview: 'Співбесіда',
  offer: 'Офер',
};

/** Колір/тло/рамка бейджа fit% — пороги з макета: ≥85 / ≥70 / решта. */
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
      label: `${score}% fit`,
    };
  if (score >= 70)
    return {
      tx: 'var(--color-a2)',
      bg: 'rgba(255,164,92,.14)',
      brd: 'rgba(255,164,92,.4)',
      label: `${score}% fit`,
    };
  return {
    tx: 'var(--color-tx2)',
    bg: 'var(--color-glass)',
    brd: 'var(--color-glassb)',
    label: `${score}% fit`,
  };
}
