import { describe, expect, it } from 'vitest';
import { defaultTogetherWindow } from './together-window.ts';

describe('useful initial meeting window in Kyiv', () => {
  it('starts with the coming evening during the day', () => {
    expect(defaultTogetherWindow(Date.parse('2026-10-19T08:00:00Z'))).toEqual({
      from: '2026-10-19',
      to: '2026-10-19',
      startTime: '17:30',
      endTime: '22:00',
    });
  });
  it('leaves preparation time when the evening has already started', () => {
    expect(defaultTogetherWindow(Date.parse('2026-10-19T16:10:00Z'))).toMatchObject({
      from: '2026-10-19',
      startTime: '20:00',
    });
  });
  it('uses tomorrow when there is too little time left tonight', () => {
    expect(defaultTogetherWindow(Date.parse('2026-10-19T19:10:00Z'))).toEqual({
      from: '2026-10-20',
      to: '2026-10-20',
      startTime: '17:30',
      endTime: '22:00',
    });
  });
  it('uses the local day at midnight and across the autumn DST change', () => {
    expect(defaultTogetherWindow(Date.parse('2026-10-24T22:15:00Z'))).toMatchObject({
      from: '2026-10-25',
      startTime: '17:30',
    });
    expect(defaultTogetherWindow(Date.parse('2026-10-25T19:40:00Z'))).toMatchObject({
      from: '2026-10-26',
      startTime: '17:30',
    });
  });
});
