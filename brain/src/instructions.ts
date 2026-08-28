// Дзеркало хешу інструкцій (web/core/instructions.mjs). Мозок не має доступу
// до D1, тож персона приходить у тілі /run - і єдиний спосіб переконатись, що
// в дорозі нічого не змінилось, це перерахувати хеш самому.
//
// Парність із ядром тримає тест: той самий текст → той самий hex. Розійдуться
// реалізації - тест червоний, а не мовчазна відмова кожного прогону в проді.

import { createHash } from 'node:crypto';

/**
 * sha256 тіла інструкції, hex. Нормалізація переносів - як у ядрі: тіло
 * подорожує через JSON і D1, і CRLF десь по дорозі не має міняти хеш.
 */
export function instructionHash(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Перевірити інструкцію з тіла /run. Повертає текст для промпту або кидає -
 * вшитого запасного тексту немає свідомо (01 §2.1: «нема/розійшлось →
 * помилка»), інакше прод місяцями їхав би на старій персоні непомітно.
 */
export function verifyInstruction(
  instruction: { name: string; version_hash: string; body_md: string } | undefined,
  profileName: string,
  expectedName?: string,
): string {
  if (!instruction) {
    throw new Error(`instructions: профіль ${profileName} прийшов без інструкції`);
  }
  // Ім'я звіряється з очікуваним для профілю (ревʼю PR-5): помилка ядра, що
  // надішле quick для chat, інакше дала б відповідь чужою персоною - і жодного
  // сліду, бо хеш при цьому цілий.
  if (expectedName && instruction.name !== expectedName) {
    throw new Error(
      `instructions: профіль ${profileName} чекав «${expectedName}», прийшла «${instruction.name}»`,
    );
  }
  const actual = instructionHash(instruction.body_md);
  if (actual !== instruction.version_hash) {
    throw new Error(
      `instructions: хеш «${instruction.name}» розійшовся з тілом (очікували ${instruction.version_hash.slice(0, 12)}, порахували ${actual.slice(0, 12)})`,
    );
  }
  return instruction.body_md;
}
