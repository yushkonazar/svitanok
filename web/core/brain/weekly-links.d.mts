export function weeklyReportPathForStartParam(param: string): string | null;
export function weeklyOverviewButtons(
  env: { TELEGRAM_BOT_USERNAME?: string; MINI_APP_URL?: string },
  chatId: string | number,
  week: string,
): Array<Array<{ text: string; url?: string; web_app?: { url: string } }>>;
