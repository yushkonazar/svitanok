// Стадії воронки вакансій (роадмеп v3, E3) — 1:1 з index.html JOB_STAGES
// (2326-2332). irrelevant — ефемерна дія (job_dismiss), не персистентна стадія.

export type FunnelStage = 'saved' | 'applied' | 'interview' | 'offer';

export const JOB_STAGES = [
  { key: 'saved', label: 'Збережено', short: 'Зберегти' },
  { key: 'applied', label: 'Подав', short: 'Подав' },
  { key: 'interview', label: 'Співбесіда', short: 'Співбесіда' },
  { key: 'offer', label: 'Офер', short: 'Офер' },
  { key: 'irrelevant', label: 'Не рел.', short: 'Не релевантно' },
] as const;

// Реальні стадії воронки (без irrelevant) — для віджета й кнопок переміщення.
export const FUNNEL_STAGES = JOB_STAGES.filter((s) => s.key !== 'irrelevant') as {
  key: FunnelStage;
  label: string;
  short: string;
}[];

export const STAGE_LABEL: Record<FunnelStage, string> = {
  saved: 'Збережено',
  applied: 'Подав',
  interview: 'Співбесіда',
  offer: 'Офер',
};
