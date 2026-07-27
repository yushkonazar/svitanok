// "Переглянуто" для чіпів тем (фідбек власника, фото 2) — кільце чіпа помаранчеве,
// доки в темі є щось, чого власник ще не відкривав, і сіріє, щойно він відкрив
// повний список теми (Hero/Compact/Sheet — будь-який шлях, що веде до
// NewsScreen.openTopic). Мітка — url найновішого айтема групи, а не просто
// timestamp: групи вже відсортовані бекендом за publishedAt (найновіші перші),
// тож "url топ-айтема змінився" == "з'явилось щось нове після останнього
// перегляду", без потреби парсити/порівнювати дати на клієнті.
//
// localStorage, не сервер: суто UI-стан одного пристрою, як і demo-режим
// налаштувань — не варте нової колонки в KV.

const KEY = 'svitanok:newsSeenTopics';

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** true — немає нового з часу останнього перегляду (чи тема порожня). */
export function isTopicSeen(key: string, latestUrl: string | undefined): boolean {
  if (!latestUrl) return true;
  return readMap()[key] === latestUrl;
}

export function markTopicSeen(key: string, latestUrl: string | undefined): void {
  if (!latestUrl) return;
  const map = readMap();
  if (map[key] === latestUrl) return;
  map[key] = latestUrl;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* приватний режим/квота — деградуємо мовчки, кільце просто не запам'ятає */
  }
}
