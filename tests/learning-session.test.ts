import { describe, expect, it } from 'vitest';
import {
  awaitingTutorAnswer,
  changeTutorStatus,
  rateTutorSession,
  readTutorSession,
  saveTutorWorkerResult,
  submitTutorAnswer,
  tutorAnswerFollowup,
  tutorButtons,
  tutorQuestion,
  renderTutorWorkerText,
  structuredTutorResult,
} from '../web/core/brain/learning-session.mjs';
import { d1WithInstructions } from './helpers/instructions.js';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const QUESTION =
  '🎓 SQL індекси\nЯкий індекс допоможе пошуку за містом?\nМожеш відповісти або попросити підказку.';

function setup() {
  const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
  return { db: d1.db, env: workerEnv({ DB: d1.stub }) };
}

describe('збережена навчальна сесія', () => {
  it('приймає структурований результат без залежності від дослівної фрази', async () => {
    const { env } = setup();
    const question = JSON.stringify({
      kind: 'question',
      topic: 'SQL',
      text: 'Який індекс обереш?',
    });
    expect(structuredTutorResult(question)?.kind).toBe('question');
    expect(tutorQuestion(question)).toEqual({
      topic: 'SQL',
      question: '🎓 SQL\nЯкий індекс обереш?',
    });
    expect(renderTutorWorkerText(question)).toBe('🎓 SQL\nЯкий індекс обереш?');
    expect(renderTutorWorkerText('{bad json')).not.toContain('{bad json');
    await saveTutorWorkerResult(env, {
      id: 'structured-q',
      text: question,
      threadId: 'dm',
      chatId: '555',
      nowMs: NOW,
    });
    const session = await readTutorSession(env, 'structured-q');
    expect(session?.status).toBe('question');
    await changeTutorStatus(
      env,
      'structured-q',
      '555',
      'dm',
      'question',
      'awaiting_answer',
      NOW + 1,
    );
    await submitTutorAnswer(env, session!, 'За містом', NOW + 2);
    const review = await saveTutorWorkerResult(env, {
      id: 'structured-r',
      text: JSON.stringify({ kind: 'review', topic: 'SQL', text: 'Індекс за містом підходить.' }),
      threadId: 'dm',
      chatId: '555',
      nowMs: NOW + 3,
    });
    expect(review?.status).toBe('reviewed');
    expect(review?.review_text).toContain('Індекс за містом підходить.');
  });

  it('визначає лише формальне питання і дає кнопки, привʼязані до id', () => {
    expect(tutorQuestion(QUESTION)).toEqual({ topic: 'SQL індекси', question: QUESTION });
    expect(tutorQuestion('🎓 SQL індекси\nЦе пояснення, а не питання.')).toBeNull();
    expect(tutorQuestion('')).toBeNull();
    expect(tutorQuestion(null as unknown as string)).toBeNull();
    expect(tutorQuestion('🎓 Тема\nМожеш відповісти або попросити підказку.')).toEqual({
      topic: 'Тема',
      question: '🎓 Тема\nМожеш відповісти або попросити підказку.',
    });
    expect(tutorQuestion(`${QUESTION}${'x'.repeat(3_500)}`)).toBeNull();
    expect(
      tutorQuestion(`🎓 Тема\n${'x'.repeat(3_500)}\nМожеш відповісти або попросити підказку.`),
    ).toBeNull();
    expect(
      tutorButtons('q1', 'question')
        .flat()
        .map((button) => button.callback_data),
    ).toEqual([
      'm:tu:q1:hint',
      'm:tu:q1:example',
      'm:tu:q1:answer',
      'm:tu:q1:skip',
      'm:tu:q1:finish',
    ]);
    expect(tutorButtons('q1', 'awaiting_answer').flat()).toHaveLength(2);
    expect(tutorButtons('q1', 'reviewed').flat()).toHaveLength(3);
  });

  it('звичайне пояснення не створює сесії, а запізніла підказка не оживляє закриту', async () => {
    const { env } = setup();
    expect(
      await saveTutorWorkerResult(env, {
        id: 'plain',
        text: 'Це лише пояснення.',
        threadId: '99',
        chatId: '555',
        nowMs: NOW,
      }),
    ).toBeNull();
    await saveTutorWorkerResult(env, {
      id: 'q1',
      text: QUESTION,
      threadId: '99',
      chatId: '555',
      nowMs: NOW,
    });
    expect(
      (
        await saveTutorWorkerResult(env, {
          id: 'hint',
          text: '💡 Подумай про фільтр.',
          threadId: '99',
          chatId: '555',
          nowMs: NOW + 1,
        })
      )?.id,
    ).toBe('q1');
    expect(await changeTutorStatus(env, 'q1', '555', '99', 'question', 'closed', NOW + 2)).toBe(
      true,
    );
    expect(
      await saveTutorWorkerResult(env, {
        id: 'late',
        text: '💡 Запізніла підказка.',
        threadId: '99',
        chatId: '555',
        nowMs: NOW + 3,
      }),
    ).toBeNull();
  });

  it('без D1 не обіцяє збереженої навчальної сесії', async () => {
    const env = workerEnv({ DB: undefined });
    await expect(readTutorSession(env, 'missing')).rejects.toThrow('DB');
    await expect(
      saveTutorWorkerResult(env, {
        id: 'q1',
        text: QUESTION,
        threadId: '99',
        chatId: '555',
        nowMs: NOW,
      }),
    ).rejects.toThrow('DB');
  });

  it('зберігає питання, відповідь, розбір і самооцінку крізь нові запити', async () => {
    const { env } = setup();
    const initial = await saveTutorWorkerResult(env, {
      id: 'q1',
      text: QUESTION,
      threadId: '99',
      chatId: '555',
      nowMs: NOW,
    });
    expect(initial).toMatchObject({ status: 'question', topic: 'SQL індекси' });
    expect(
      await changeTutorStatus(env, 'q1', '555', '99', 'question', 'awaiting_answer', NOW + 1),
    ).toBe(true);
    expect(
      await changeTutorStatus(env, 'q1', '555', '99', 'question', 'awaiting_answer', NOW + 2),
    ).toBe(false);
    const awaiting = await awaitingTutorAnswer(env, '99', '555');
    expect(awaiting?.id).toBe('q1');
    expect(await awaitingTutorAnswer(env, '99', 'other-chat')).toBeNull();
    expect(await submitTutorAnswer(env, awaiting!, 'Індекс за містом.', NOW + 3)).toBe(true);
    expect(await submitTutorAnswer(env, awaiting!, 'Інша відповідь.', NOW + 4)).toBe(false);
    expect(tutorAnswerFollowup(awaiting!, 'Індекс за містом.')).toContain(JSON.stringify(QUESTION));
    expect(await awaitingTutorAnswer(env, '99', '555')).toBeNull();
    expect(
      await saveTutorWorkerResult(env, {
        id: 'late-hint',
        text: '💡 Подумай про порядок полів.',
        threadId: '99',
        chatId: '555',
        nowMs: NOW + 4,
      }),
    ).toBeNull();
    expect((await readTutorSession(env, 'q1'))?.status).toBe('answer_submitted');
    const review = await saveTutorWorkerResult(env, {
      id: 'review-report',
      text: '🎓 SQL індекси\nЄ в рішенні: фільтр.\nДалі: на цьому все.',
      threadId: '99',
      chatId: '555',
      nowMs: NOW + 5,
    });
    expect(review).toMatchObject({
      id: 'q1',
      status: 'reviewed',
      answer_text: 'Індекс за містом.',
    });
    const due = await rateTutorSession(env, review!, 'hard', NOW + 6);
    expect(due).toBe(new Date(NOW + 6 + 86_400_000).toISOString());
    expect(await rateTutorSession(env, review!, 'easy', NOW + 7)).toBeNull();
    expect(await readTutorSession(env, 'q1')).toMatchObject({ rating: 'hard', status: 'rated' });
  });

  it('нове питання замінює старе, але помилка збереження не гасить активну сесію', async () => {
    const { env } = setup();
    await saveTutorWorkerResult(env, {
      id: 'q1',
      text: QUESTION,
      threadId: '99',
      chatId: '555',
      nowMs: NOW,
    });
    await expect(
      saveTutorWorkerResult(env, {
        id: 'q1',
        text: QUESTION,
        threadId: '99',
        chatId: '555',
        nowMs: NOW + 1,
      }),
    ).rejects.toThrow();
    expect((await readTutorSession(env, 'q1'))?.status).toBe('question');
    await saveTutorWorkerResult(env, {
      id: 'q2',
      text: QUESTION,
      threadId: '99',
      chatId: '555',
      nowMs: NOW + 2,
    });
    expect((await readTutorSession(env, 'q1'))?.status).toBe('superseded');
    expect((await readTutorSession(env, 'q2'))?.status).toBe('question');
  });
});
