export const MONOBANK_PURCHASE_CATEGORIES: { monoId: number; value: string; label: string }[];
export const INSTALLMENT_CATEGORY: string;
export function financeCategories(existing?: string[]): string[];
export function financeCategoryLabel(value: string): string;
