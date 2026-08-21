import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveRoadmapCallback } from '../web/callbacks.mjs';

/* Регресія, знайдена рев'ю PR #334.
 *
 * Перехід на `updateState` (C4) забрав інваріант, який доти тримався сам собою:
 * доти `state.roadmapProgress` ЗАВЖДИ присвоювався результатом `toggleProgress`,
 * тобто після запису поле гарантовано існувало. Тепер патч має гілку «копія вже
 * в цільовому стані -> поверни `s` як є», а `s` — це свіжий блоб із KV, у якому
 * поля може не бути взагалі.
 *
 * Далі результат іде у `formatTopicMessage`/`buildTopicKeyboard`, а ті роблять
 * `ключ in progress`. `in undefined` — не `false`, а TypeError: callback падає,
 * тост не приходить, кнопка в чаті виглядає мертвою.
 *
 * Вікно вузьке (потрібен конкурентний писар, що поклав блоб без цього поля), але
 * ціна фікса — `?? {}`, а ціна відмови — краш у руках власника.
 */

const TOPIC = 'frontend';
const SUBTOPIC = 'html-semantics';
const KEY = `${TOPIC}.${SUBTOPIC}`;

let kv: Map<string, string>;
let edits: { text: string; markup: unknown }[];

/**
 * KV, у якому N-не читання 'state' віддає ІНШИЙ блоб.
 * Саме так виглядає конкурентний писар, що встиг між двома читаннями updateState.
 */
function env(swapOnRead: number, swapped: unknown) {
  let reads = 0;
  return {
    BRIEFING: {
      get: async (k: string) => {
        if (k !== 'state') return kv.get(k) ?? null;
        return ++reads === swapOnRead ? JSON.stringify(swapped) : (kv.get(k) ?? null);
      },
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: '4242',
  };
}

const parsed = { chatId: 4242, messageId: 7 };
const toggle = { kind: 'toggle', topicId: TOPIC, subtopicId: SUBTOPIC };

beforeEach(() => {
  kv = new Map();
  edits = [];
  // editMessageText іде через tgCall -> fetch. Ловимо виклик, щоб перевірити,
  // що повідомлення таки перемалювали, а не тихо проковтнули помилку.
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    edits.push({ text: body.text, markup: body.reply_markup });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
});

describe('resolveRoadmapCallback — свіжий блоб без roadmapProgress', () => {
  it('не падає, коли конкурентний писар прибрав поле між читаннями', async () => {
    // Прочитане: підпункт ПОЗНАЧЕНИЙ (wasDone = true).
    kv.set('state', JSON.stringify({ roadmapProgress: { [KEY]: '2026-08-01T00:00:00.000Z' } }));

    // Друге читання updateState (третє загалом: одне — `state` для wasDone,
    // далі пара всередині updateState) віддає блоб, де поля немає зовсім.
    // Патч бачить `KEY in {} === !true` -> false === false -> повертає `s`.
    const toast = await resolveRoadmapCallback(env(3, { lastUpdateId: 9 }), parsed, toggle);

    expect(toast).toBe('↩️ Знято позначку');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('0/'); // жодного позначеного підпункту
  });

  it('звичайний шлях без конкурента: позначку поставлено й повідомлення перемальовано', async () => {
    kv.set('state', JSON.stringify({ roadmapProgress: {} }));

    const toast = await resolveRoadmapCallback(env(0, null), parsed, toggle);

    expect(toast).toBe('✅ Позначено');
    expect(JSON.parse(kv.get('state')!).roadmapProgress[KEY]).toBeTruthy();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('1/');
  });
});
