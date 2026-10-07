export function weeklyReview(
  records: Record<string, any>,
  today: string,
  completed?: boolean,
): {
  from: string;
  to: string;
  days: number;
  recordedDays: number;
  items: { id: string; title: string; text: string; n: number; dates: string[] }[];
};
