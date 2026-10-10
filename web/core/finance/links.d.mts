export interface FinanceLinkButton {
  text: string;
  url?: string;
  web_app?: { url: string };
}
export function financeStartParam(kind: string, id: string): string | null;
export function financePathForStartParam(param: string): string | null;
export function financeMiniAppButton(
  env: { TELEGRAM_BOT_USERNAME?: string; MINI_APP_URL?: string },
  text: string,
  kind: string,
  id: string,
  chatId: string | number | null,
): FinanceLinkButton | null;
