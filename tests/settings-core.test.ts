import { describe, it, expect } from 'vitest';
import { emptySettings, normalizeSettings } from '../web/settings-core.mjs';
import { parseHhmm, fmtHhmm, isQuietMinute, connectorStatus } from '../web/settings-core.mjs';
import { TOGGLEABLE_MODULE_IDS } from '../web/settings-core.mjs';

const at = (h: number, m = 0) => h * 60 + m;

describe('settings-core — parseHhmm / fmtHhmm', () => {
  it('парсить валідний час, включно з однознаковою годиною', () => {
    expect(parseHhmm('00:00')).toBe(0);
    expect(parseHhmm('9:05')).toBe(545);
    expect(parseHhmm('23:59')).toBe(1439);
    expect(parseHhmm(' 22:00 ')).toBe(1320);
  });

  it('відкидає невалідне', () => {
    for (const bad of ['24:00', '12:60', '', 'abc', '1200', '12:0', null, 5, undefined, {}]) {
      expect(parseHhmm(bad)).toBeNull();
    }
  });

  it('форматує канонічно, з нулями', () => {
    expect(fmtHhmm(0)).toBe('00:00');
    expect(fmtHhmm(545)).toBe('09:05');
    expect(fmtHhmm(1439)).toBe('23:59');
  });
});

describe('settings-core — normalizeSettings', () => {
  it('порожній/битий вхід -> дефолт із ВИМКНЕНИМИ тихими годинами', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(normalizeSettings(bad)).toEqual(emptySettings());
    }
    expect(emptySettings().quiet.enabled).toBe(false);
  });

  it('невалідний час відкочується на дефолт, валідний канонізується', () => {
    const s = normalizeSettings({ quiet: { enabled: true, from: '9:30', to: '25:00' } });
    expect(s.quiet).toEqual({ enabled: true, from: '09:30', to: '08:00' });
  });

  it('enabled — суворо boolean true (truthy-рядок не вмикає тишу)', () => {
    expect(normalizeSettings({ quiet: { enabled: 'yes' } }).quiet.enabled).toBe(false);
    expect(normalizeSettings({ quiet: { enabled: 1 } }).quiet.enabled).toBe(false);
    expect(normalizeSettings({ quiet: { enabled: true } }).quiet.enabled).toBe(true);
  });

  it('лишає лише відомі id модулів і лише boolean-значення', () => {
    const s = normalizeSettings({
      modules: { weather: false, news: true, chaos: false, jobs: 'off' },
    });
    expect(s.modules).toEqual({ weather: false, news: true });
  });

  it('усі перемикні id проходять нормалізацію', () => {
    const all = Object.fromEntries(TOGGLEABLE_MODULE_IDS.map((id: string) => [id, false]));
    expect(normalizeSettings({ modules: all }).modules).toEqual(all);
  });
});

describe('settings-core — mutedTopics (фільтр тем новин)', () => {
  it('дефолт — порожній список', () => {
    expect(emptySettings().mutedTopics).toEqual([]);
    expect(normalizeSettings({}).mutedTopics).toEqual([]);
  });

  it('лишає непорожні рядки, чистить дублі й сміття', () => {
    const s = normalizeSettings({
      mutedTopics: ['Спорт', 'Спорт', '  Культура  ', '', '   ', 42, null, {}],
    });
    expect(s.mutedTopics).toEqual(['Спорт', 'Культура']);
  });

  it('не список -> порожньо (битий блоб не валить нормалізацію)', () => {
    expect(normalizeSettings({ mutedTopics: 'Спорт' }).mutedTopics).toEqual([]);
    expect(normalizeSettings({ mutedTopics: null }).mutedTopics).toEqual([]);
  });

  it('кап списку — блоб не росте безмежно', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Тема${i}`);
    expect(normalizeSettings({ mutedTopics: many }).mutedTopics).toHaveLength(40);
  });
});

describe('settings-core — isQuietMinute', () => {
  const quiet = (o: Record<string, unknown>) => ({ quiet: { enabled: true, ...o }, modules: {} });

  it('вимкнені тихі години -> ніколи не тихо', () => {
    expect(isQuietMinute({ quiet: { enabled: false, from: '22:00', to: '08:00' } }, at(3))).toBe(
      false,
    );
  });

  it('вікно через північ: тихо вночі, гучно вдень', () => {
    const s = quiet({ from: '22:00', to: '08:00' });
    expect(isQuietMinute(s, at(22))).toBe(true); // from — включно
    expect(isQuietMinute(s, at(23, 59))).toBe(true);
    expect(isQuietMinute(s, at(0))).toBe(true);
    expect(isQuietMinute(s, at(7, 59))).toBe(true);
    expect(isQuietMinute(s, at(8))).toBe(false); // to — НЕ включно
    expect(isQuietMinute(s, at(13))).toBe(false);
    expect(isQuietMinute(s, at(21, 59))).toBe(false);
  });

  it('вікно в межах доби (обідня тиша)', () => {
    const s = quiet({ from: '13:00', to: '14:00' });
    expect(isQuietMinute(s, at(12, 59))).toBe(false);
    expect(isQuietMinute(s, at(13))).toBe(true);
    expect(isQuietMinute(s, at(13, 30))).toBe(true);
    expect(isQuietMinute(s, at(14))).toBe(false);
    expect(isQuietMinute(s, at(3))).toBe(false);
  });

  it('from === to -> вікно порожнє, а не ціла доба', () => {
    const s = quiet({ from: '10:00', to: '10:00' });
    for (const h of [0, 9, 10, 11, 23]) expect(isQuietMinute(s, at(h))).toBe(false);
  });
});

describe('settings-core — connectorStatus', () => {
  it('без секретів — усе вимкнено', () => {
    expect(connectorStatus({ hasGoogleCreds: false, scope: 'x' })).toEqual({
      google: false,
      calendar: false,
      gmail: false,
      contacts: false,
    });
  });

  it('секрети є, скоупи ще не закешовані -> calendar/gmail (спільний консент), contacts=false (PR-10, НОВИЙ скоуп, потребує ре-консенту)', () => {
    for (const scope of [null, undefined, '', '   ', 42]) {
      expect(connectorStatus({ hasGoogleCreds: true, scope })).toEqual({
        google: true,
        calendar: true,
        gmail: true,
        contacts: false,
      });
    }
  });

  it('скоупи відомі -> кожен сервіс за своїм скоупом (включно з contacts, PR-10)', () => {
    const scope =
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
    expect(connectorStatus({ hasGoogleCreds: true, scope })).toEqual({
      google: true,
      calendar: true,
      gmail: false,
      contacts: false,
    });
    expect(
      connectorStatus({
        hasGoogleCreds: true,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
    ).toEqual({ google: true, calendar: false, gmail: true, contacts: false });
    expect(
      connectorStatus({
        hasGoogleCreds: true,
        scope: 'https://www.googleapis.com/auth/contacts.readonly',
      }),
    ).toEqual({ google: true, calendar: false, gmail: false, contacts: true });
  });
});
