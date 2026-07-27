// Детект "тема-релізи" за назвою (редизайн новин) — той самий підхід, що вже є
// в topicEmoji.ts для іконки 🚀: жодного нового поля в бекенді/схемі не треба.
// Релізи — інша форма даних, ніж новина (версія+час, без "чому"), тож екран
// рендерить їх окремим форматом картки.

export function isReleaseTopic(topic: string): boolean {
  return /реліз|release/i.test(topic);
}

/** Стабільний ключ теми (scope+назва) — той самий формат для Sheet-стану й "переглянуто". */
export function topicKey(g: { scope: string; topic: string }): string {
  return `${g.scope}:${g.topic}`;
}
