// Пагінація архіву збереженого — чиста логіка, окремо від хука (щоб тест не
// тягнув React). Живе тут, а не в web/*-core.mjs: це правило КЛІЄНТА, сервер
// про сторінки нічого не памʼятає — він лише ріже зріз за offset/limit.

/** Мінімум із SavedPage, потрібний для рішення про наступну сторінку. */
export interface Page {
  items: unknown[];
  total: number;
}

/**
 * Offset наступної сторінки або undefined, якщо архів вичерпано.
 *
 * ⚠️ Чому саме offset, а не «попроси більший limit»: сервер клампить limit до
 * SAVED_PAGE_MAX=50 (stats-core.mjs). Старий екран ріс limit'ом 20→40→60… при
 * зашитому offset=0 — і на 51-му записі мовчки впирався в стелю: «Показати ще
 * (N)» рахувало залишок чесно, але не додавало НІЧОГО.
 *
 * Порожня сторінка спиняє гортання окремо від лічильника: якщо total збрехав
 * (а він читається з KV, який відстає), інакше крутили б порожні сторінки вічно.
 */
export function nextSavedOffset(pages: Page[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last || !last.items.length) return undefined;
  const loaded = pages.reduce((n, p) => n + p.items.length, 0);
  return loaded >= last.total ? undefined : loaded;
}
