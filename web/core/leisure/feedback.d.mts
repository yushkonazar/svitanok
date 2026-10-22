export interface LeisureFeedbackChoice {
  code: string;
  label: string;
  scope: string | null;
}
export function leisureFeedbackChoices(
  category: string,
  positive?: boolean,
): LeisureFeedbackChoice[];
export function normalizeLeisureFeedback(item: any, payload: any, current: any, nowMs: number): any;
export function leisureFeedbackScopes(record: any): string[] | null;
export function leisureReactionSnapshot(record: any): any;
