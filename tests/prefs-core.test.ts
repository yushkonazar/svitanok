import { describe, it, expect } from 'vitest';
import {
  applyVote,
  applyUrlVote,
  updateJobPrefs,
  updateMockWeight,
  WEIGHT_MIN,
  WEIGHT_MAX,
  // @ts-expect-error — JS-модуль Worker'а без типів.
} from '../web/prefs-core.mjs';
// Канонічні (TS) версії тих самих формул — Worker тримає ДЗЕРКАЛО, бо не
// імпортує TS. Саме розходження дзеркал і ловить цей файл.
import { applyVote as tsApplyVote, applyUrlVote as tsApplyUrlVote } from '../src/modules/news.js';
import { updateJobPrefs as tsUpdateJobPrefs } from '../src/modules/jobs.js';
import { updateMockWeight as tsUpdateMockWeight } from '../src/modules/mock.js';

/* Ваги вподобань, витягнуті з worker.js (Фаза 5, модуляризація).
 *
 * Найцінніше тут — не «функція рахує», а те, що ДВІ реалізації однієї формули
 * (Worker-дзеркало й канонічний TS оркестратора) не розʼїхались: інакше та сама
 * дія власника дає різну вагу залежно від того, хто її обробив — 👍 у дашборді
 * (Worker) чи ранковий прогін (orchestrator). Розходження було б тихим: ваги
 * ніде не показуються, лише зсувають добірку. */

describe('preferenceWeights — дзеркало не розʼїхалось із src/modules/news.ts', () => {
  it('applyVote дає ТОЧНО той самий результат, що канонічна версія', () => {
    const cases: [Record<string, number>, string, 'up' | 'down'][] = [
      [{}, 'Тех', 'up'],
      [{ Тех: 1.0 }, 'Тех', 'down'],
      [{ Тех: WEIGHT_MAX }, 'Тех', 'up'], // на стелі
      [{ Тех: WEIGHT_MIN }, 'Тех', 'down'], // на дні
    ];
    for (const [w, cat, dir] of cases) {
      expect(applyVote(w, cat, dir)).toEqual(tsApplyVote({ ...w }, cat, dir));
    }
  });

  it('applyUrlVote збігається і на постановці, і на toggle-off, і на зміні напрямку', () => {
    const url = 'https://example.com/a';
    const run = (impl: typeof applyUrlVote) => {
      const first = impl({}, {}, url, 'Тех', 'up');
      const same = impl(first.weights, first.votedUrls, url, 'Тех', 'up'); // зняти
      const flip = impl(first.weights, first.votedUrls, url, 'Тех', 'down'); // переставити
      return { first, same, flip };
    };
    expect(run(applyUrlVote)).toEqual(run(tsApplyUrlVote as typeof applyUrlVote));
  });

  it('відкат біля межі точний: голос-no-op не штовхає вагу в протилежний бік', () => {
    // Вага вже на дні -> 👎 нічого не зсуває (delta=0). Зняття цього голосу
    // мусить лишити вагу на дні, а не «повернути» номінальні +0.15.
    const url = 'https://example.com/b';
    const at = { Тех: WEIGHT_MIN };
    const voted = applyUrlVote(at, {}, url, 'Тех', 'down');
    expect(voted.weights['Тех']).toBe(WEIGHT_MIN);
    const undone = applyUrlVote(voted.weights, voted.votedUrls, url, 'Тех', 'down');
    expect(undone.weights['Тех']).toBe(WEIGHT_MIN);
    expect(undone.votedUrls[url]).toBeUndefined();
  });
});

describe('jobPrefs / mockWeights — дзеркала теж збігаються', () => {
  it('updateJobPrefs: токени, cap і перенос між liked/disliked — як у src/modules/jobs.ts', () => {
    const prefs = { liked: ['go'], disliked: ['php'] };
    for (const signal of ['dismiss', 'applied', 'interview', 'offer'] as const) {
      expect(updateJobPrefs(prefs, signal, 'Junior Go Developer (Kyiv)')).toEqual(
        tsUpdateJobPrefs({ ...prefs }, signal, 'Junior Go Developer (Kyiv)'),
      );
    }
  });

  it('стоп-слова відкидаються — «junior developer» сам по собі нічого не вчить', () => {
    const prefs = { liked: [], disliked: [] };
    expect(updateJobPrefs(prefs, 'dismiss', 'Junior Developer')).toBe(prefs); // той самий обʼєкт
  });

  it('updateMockWeight: hard піднімає, easy опускає — як у src/modules/mock.ts', () => {
    for (const rating of ['hard', 'easy'] as const) {
      expect(updateMockWeight({ HTTP: 1.0 }, 'HTTP', rating)).toEqual(
        tsUpdateMockWeight({ HTTP: 1.0 }, 'HTTP', rating),
      );
    }
    expect(updateMockWeight({ HTTP: 1.0 }, '', 'hard')).toEqual({ HTTP: 1.0 }); // без теми — no-op
  });
});
