import { MCC_CATEGORIES } from './mcc.mjs';

// Names and IDs verified against the bank's public dashboard on 2026-10-04:
// https://monobank.ua/api/dashboard/stat/ctgpay?lang=uk
// This is the published purchase catalogue, not every private-app operation.
// Reuse existing values where the meaning matches: labels must not break
// historical transactions, owner rules or budget category links.
export const MONOBANK_PURCHASE_CATEGORIES = [
  { monoId: 4, value: 'продукти', label: 'Продукти та супермаркети' },
  { monoId: 3, value: 'кафе й ресторани', label: 'Кафе та ресторани' },
  { monoId: 18, value: 'інше', label: 'Інше' },
  { monoId: 16, value: 'подорожі', label: 'Подорожі' },
  { monoId: 23, value: 'розваги та спорт', label: 'Розваги та спорт' },
  { monoId: 12, value: 'краса та здоровʼя', label: "Краса та здоров'я" },
  { monoId: 1, value: 'таксі', label: 'Таксі' },
  { monoId: 11, value: 'комуналка та інтернет', label: 'Комуналка та інтернет' },
  { monoId: 2, value: 'авто', label: 'Авто' },
  { monoId: 17, value: 'поповнення мобільного', label: 'Поповнення мобільного' },
  { monoId: 8, value: 'одяг і взуття', label: 'Одяг та взуття' },
  { monoId: 10, value: 'ремонт', label: 'Ремонт' },
  { monoId: 26, value: 'тварини', label: 'Тварини' },
  { monoId: 5, value: 'бюджет та податки', label: 'Бюджет та податки' },
  { monoId: 9, value: 'побутова техніка', label: 'Побутова техніка' },
  { monoId: 24, value: 'кіно', label: 'Кіно' },
  { monoId: 27, value: 'книги й преса', label: 'Книги' },
  { monoId: 25, value: 'duty free', label: 'Duty Free' },
];

// Banking products are not merchant MCCs. Keep them explicitly selectable;
// never infer an installment merely from an electronics merchant's MCC.
export const INSTALLMENT_CATEGORY = 'покупка частинами';
const PERSONAL_CATEGORIES = ['дохід', 'зарплата', 'таксі', 'таксі · особисте', 'чайові'];
const LABELS = new Map(MONOBANK_PURCHASE_CATEGORIES.map((c) => [c.value, c.label]));

/** @param {string[]} [existing] */
export function financeCategories(existing = []) {
  return [
    ...new Set([
      ...MONOBANK_PURCHASE_CATEGORIES.map((c) => c.value),
      INSTALLMENT_CATEGORY,
      'розстрочка',
      ...MCC_CATEGORIES,
      ...PERSONAL_CATEGORIES,
      ...existing.filter((c) => typeof c === 'string' && c.trim()),
    ]),
  ];
}

/** @param {string} value */
export function financeCategoryLabel(value) {
  return LABELS.get(value) ?? value.charAt(0).toLocaleUpperCase('uk-UA') + value.slice(1);
}
