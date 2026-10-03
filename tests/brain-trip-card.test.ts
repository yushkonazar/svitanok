import { describe, it, expect } from 'vitest';
import { tripBriefCard } from '../brain/src/trip-card.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const valid = () => ({
  draft_id: id,
  question_card: {
    text: '🧳 Чим їдеш?',
    buttons: [[{ text: 'Авто', callback_data: `m:tb:${id}:mode:0:123ab` }]],
  },
});
describe('Brain trip card delivery envelope', () => {
  it('accepts a core-produced bounded card without importing Worker runtime files', () => {
    expect(tripBriefCard(valid())).toEqual(valid().question_card);
  });
  it.each([null, {}, { draft_id: id, question_card: { text: 'x', buttons: [] } }])(
    'rejects an incomplete envelope %j',
    (raw) => expect(tripBriefCard(raw)).toBeNull(),
  );
  it('rejects foreign draft callbacks and unrelated actions', () => {
    const raw = valid();
    raw.question_card.buttons[0]![0]!.callback_data = 'm:done';
    expect(tripBriefCard(raw)).toBeNull();
    raw.question_card.buttons[0]![0]!.callback_data = `m:tb:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:mode:0:123ab`;
    expect(tripBriefCard(raw)).toBeNull();
  });
  it('rejects unbounded text and buttons', () => {
    const raw = valid();
    raw.question_card.text = 'x'.repeat(2001);
    expect(tripBriefCard(raw)).toBeNull();
    raw.question_card.text = 'x';
    raw.question_card.buttons[0]![0]!.text = 'x'.repeat(41);
    expect(tripBriefCard(raw)).toBeNull();
  });
});
