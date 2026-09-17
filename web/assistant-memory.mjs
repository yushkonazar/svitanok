// Памʼять розмови з асистентом — писарі (Фаза 5, модуляризація worker.js).
//
// Чиста логіка памʼяті (clip, кап реплік, рендер для промпту) живе в
// assistant-memory-core; тут — два єдині місця, які цю памʼять ПИШУТЬ, і
// правило, коли саме:
//
//   rememberExchange        — ЛИШЕ на успішному фініші прогону. Провалений
//     (часто оверсайзний) обмін інакше отруював би контекст наступних.
//   rememberAssistantQuestion — коли питання поставила КНОПКА, а не модель:
//     user-репліки просто немає, і наступне справжнє повідомлення власника
//     ляже поверх («ПРОДОВЖЕННЯ РОЗМОВИ» у системному промпті вже навчена
//     трактувати його як відповідь).
//
// Обидві best-effort: збій control plane не сміє з'їсти відповідь власнику.

import { appendAssistantHistory } from './kv-store.mjs';

/** @typedef {import('./agent-run-core.mjs').RunClaims} RunClaims */

/**
 * Записати обмін у памʼять треду. Викликається ЛИШЕ на успішному фініші — як і
 * до переходу: провалений (часто оверсайз) обмін інакше отруював би контекст
 * наступних повідомлень. Текст користувача приїхав у підписаному токені, тож
 * KV-розсинхрон не може його загубити.
 * @param {Env} env
 * @param {RunClaims} claims
 * @param {string} assistantSummary
 */
export async function rememberExchange(env, claims, assistantSummary) {
  try {
    await appendAssistantHistory(env, claims.chatId, claims.threadId, [
      { role: 'user', text: claims.userText },
      { role: 'assistant', text: assistantSummary },
    ]);
  } catch (e) {
    console.error('assistantHistory write failed (не блокує відповідь)', e);
  }
}

/**
 * Записати ЛИШЕ репліку асистента (без user-репліки) — гібридне «✏️
 * Інше»/«✏️ Редагувати»: тригер тут кнопка, не повідомлення власника, тож
 * user-репліки просто немає. Наступне СПРАВЖНЄ повідомлення власника ляже
 * поверх — «ПРОДОВЖЕННЯ РОЗМОВИ» у системному промпті (agent-core.mjs) вже
 * навчена трактувати його як відповідь на щойно задане питання.
 * @param {Env} env
 * @param {import('./tg-core.mjs').SendTarget} parsed
 * @param {string} text
 */
export async function rememberAssistantQuestion(env, parsed, text) {
  try {
    await appendAssistantHistory(env, parsed.chatId, parsed.threadId, [
      { role: 'assistant', text },
    ]);
  } catch (e) {
    console.error('assistantHistory (question) write failed (не блокує відповідь)', e);
  }
}
