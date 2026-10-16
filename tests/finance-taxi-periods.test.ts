import { describe, it, expect } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { executeFinanceCommand, readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import {
  taxiWeek,
  taxiPeriodStart,
  taxiEntryWeek,
  prepareTaxiTransition,
  calculateTaxiWeek,
  kyivInstant,
  type TaxiPolicy,
  type TaxiEntry,
} from '../web/core/finance/planning.mjs';
import { buildFinanceReport } from '../web/core/finance/reporting.mjs';
const CUT = Date.parse('2026-10-16T09:00:00Z'),
  NOW = Date.parse('2026-10-16T15:00:00Z');
const old: TaxiPolicy = {
  id: 'initial',
  effectiveAt: '1970-01-01T00:00:00.000Z',
  fareBps: 5000,
  commissionBps: 5000,
  fuelBps: 5000,
  tipsBps: 5000,
  thresholdMinor: 2700000,
  bonusFareBps: 5500,
};
const hybrid: TaxiPolicy = {
  ...old,
  id: 'hybrid-period-1',
  effectiveAt: new Date(CUT).toISOString(),
  periodStart: true,
  weekDay: 2,
  weekHour: 12,
  weekMinute: 0,
  vehicleName: 'Гібрид',
  thresholdMinor: null,
  bonusFareBps: 5000,
};
function row(id: string, at: string, policyId = 'initial'): TaxiEntry {
  return {
    id,
    at,
    policyId,
    netCashMinor: 400000,
    commissionMinor: 70000,
    fuelMinor: 100000,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: 260000,
    paidWorkMinor: 0,
    cashReported: true,
    commissionReported: true,
  };
}
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
    '0030_finance_card_installment.sql',
    '0031_finance_installment_overpayment.sql',
    '0032_finance_interest_method.sql',
    '0033_finance_history_and_links.sql',
    '0035_finance_budget_planning.sql',
    '0041_finance_merchant_aliases.sql',
    '0043_taxi_work_periods.sql',
  ]);
  const env = workerEnv({ DB: d1.stub });
  let sequence = 0;
  async function send(
    type: string,
    payload: Record<string, unknown>,
    now = NOW,
    id = `taxi-period-command-${++sequence}`,
  ) {
    const version = (await readFinanceWorkspace(env, now)).version;
    return executeFinanceCommand(env, { id, type, payload, version }, now);
  }
  const payload = { ...hybrid, keepPreviousEntryIds: [] } as Record<string, unknown>;
  return { d1, env, send, payload };
}
describe('historical taxi work periods', () => {
  it('splits Friday noon and rolls over Wednesday noon with no gaps or overlaps', () => {
    const policies = [old, hybrid];
    expect(taxiWeek(CUT - 1, policies)).toEqual({
      key: '2026-10-12',
      from: kyivInstant('2026-10-12'),
      to: CUT,
    });
    const first = taxiWeek(CUT, policies);
    expect(first).toEqual({
      key: new Date(CUT).toISOString(),
      from: CUT,
      to: kyivInstant('2026-10-21', 12),
    });
    expect(taxiPeriodStart(first.key, policies)).toBe(CUT);
    expect(taxiWeek(first.to - 1, policies).key).toBe(first.key);
    expect(taxiWeek(first.to, policies)).toEqual({
      key: '2026-10-21',
      from: first.to,
      to: kyivInstant('2026-10-28', 12),
    });
    expect(taxiPeriodStart('2026-10-21', policies)).toBe(first.to);
    expect(() => taxiPeriodStart('2026-10-22', policies)).toThrow();
  });
  it('uses Kyiv calendar time across spring and autumn DST, including minute schedules', () => {
    const schedule = { ...hybrid, effectiveAt: '2026-01-01T00:00:00.000Z', weekMinute: 30 };
    const spring = taxiWeek(kyivInstant('2026-03-27'), [old, schedule]),
      autumn = taxiWeek(kyivInstant('2026-10-23'), [old, schedule]);
    expect((spring.to - spring.from) / 3600000).toBe(167);
    expect((autumn.to - autumn.from) / 3600000).toBe(169);
    expect(spring.to).toBe(kyivInstant('2026-04-01', 12, 30));
  });
  it('keeps a late old-car entry and isolates its bonus threshold from hybrid turnover', () => {
    const late = { ...row('late', '2026-10-16T09:13:00Z'), netCashMinor: 2600000 };
    const change = prepareTaxiTransition([late], [old], [], hybrid, ['late']);
    const entries = [
      { ...late, ...change.updates[0] },
      { ...row('new', '2026-10-16T14:00:00Z', hybrid.id), netCashMinor: 9000000 },
    ];
    const previous = calculateTaxiWeek(entries, [old, hybrid], CUT - 1),
      next = calculateTaxiWeek(entries, [old, hybrid], CUT);
    expect(previous.entries.map((e) => e.id)).toEqual(['late']);
    expect(previous.groups[0]?.boosted).toBe(false);
    expect(next.groups[0]?.boosted).toBe(false);
    expect(next.groups[0]?.fareBps).toBe(5000);
    expect(previous.entries[0]?.at).toBe(late.at);
  });
  it('keeps multiple transitions on one day distinct and does not reassign older overrides', () => {
    const first = { ...row('late', '2026-10-16T15:13:00Z'), periodKey: '2026-10-12' };
    const second = {
      ...hybrid,
      id: 'second-car',
      effectiveAt: '2026-10-16T12:00:00.000Z',
      vehicleName: 'Інше авто',
    };
    const change = prepareTaxiTransition([first], [old, hybrid], [], second, []);
    expect(change.updates).toEqual([]);
    expect(change.previous.key).toBe(hybrid.effectiveAt);
    expect(change.next.key).toBe(second.effectiveAt);
    expect(taxiEntryWeek(first, [old, hybrid, second]).key).toBe('2026-10-12');
  });
  it('rejects settled history, unknown selections, invalid schedules and conflicting future terms', () => {
    expect(() => prepareTaxiTransition([], [old], [{ weekKey: '2026-10-12' }], hybrid, [])).toThrow(
      /розрахований/,
    );
    expect(() => prepareTaxiTransition([], [old], [], hybrid, ['missing'])).toThrow(/не належить/);
    for (const patch of [
      { weekDay: 7 },
      { weekHour: 24 },
      { weekMinute: 60 },
      { vehicleName: '' },
      { weekDay: undefined },
    ])
      expect(() => prepareTaxiTransition([], [old], [], { ...hybrid, ...patch }, [])).toThrow();
    expect(() =>
      prepareTaxiTransition(
        [],
        [old, { ...hybrid, effectiveAt: '2026-10-20T12:00:00Z' }],
        [],
        hybrid,
        [],
      ),
    ).toThrow(/вже є умови/);
  });
  it('atomically preserves cash, old records and completed settlements, while opening an empty hybrid period', async () => {
    const { d1, env, send, payload } = setup();
    await send('taxi-entry', { ...row('previous', '2026-10-14T15:00:00Z'), accountId: 'cash' });
    await send('taxi-entry', { ...row('late', '2026-10-16T09:13:00Z'), accountId: 'cash' });
    const before = await readFinanceWorkspace(env, NOW),
      late = before.taxiEntries.find((e) => e.at === '2026-10-16T09:13:00.000Z')!;
    const txCount = d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
    await send('taxi-transition', { ...payload, keepPreviousEntryIds: [late.id] });
    const after = await readFinanceWorkspace(env, NOW);
    expect(after.accounts).toEqual(before.accounts);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual(txCount);
    const closed = after.taxiWeeks.find((w) => w.key === '2026-10-12')!;
    expect(closed).toMatchObject({ ...before.taxiWeeks[0], closed: true, to: CUT });
    expect(after.taxiWeeks.find((w) => w.key === hybrid.effectiveAt)).toMatchObject({
      grossMinor: 0,
      earnedMinor: 0,
      closed: false,
      settled: false,
    });
    expect(after.taxiEntries.find((e) => e.id === late.id)).toMatchObject({
      at: late.at,
      policyId: 'initial',
      periodKey: '2026-10-12',
    });
    await send('taxi-edit', {
      ...late,
      periodKey: '2026-10-12',
      entryId: late.id,
      netCashMinor: 500000,
    });
    expect(
      (await readFinanceWorkspace(env, NOW)).taxiEntries.find((e) => e.id === late.id)?.periodKey,
    ).toBe('2026-10-12');
    await send('taxi-settle', { weekKey: '2026-10-12', accountId: 'cash', amountMinor: -180000 });
    await expect(
      send('taxi-edit', { ...late, entryId: late.id, netCashMinor: 400000 }),
    ).rejects.toThrow(/Розраховану/);
    const settled = await readFinanceWorkspace(env, NOW);
    await send('taxi-entry', { ...row('new', '2026-10-16T14:00:00Z'), accountId: 'cash' });
    const newer = await readFinanceWorkspace(env, NOW);
    expect(newer.taxiWeeks.find((w) => w.key === '2026-10-12')).toEqual(
      settled.taxiWeeks.find((w) => w.key === '2026-10-12'),
    );
    expect(newer.taxiEntries[0]?.policyId).toBe(newer.policies.at(-1)?.id);
    expect(newer.taxiWeeks.find((w) => w.key === hybrid.effectiveAt)?.earnedMinor).toBe(150000);
    const report = buildFinanceReport(newer, '2026-10-12', '2026-10-16', NOW);
    const dayReport = buildFinanceReport(newer, '2026-10-16', '2026-10-16', NOW);
    expect(report.taxiEarnedMinor).toBe(500000);
    expect(dayReport.taxiEarnedMinor).toBe(350000);
    expect(report.taxiWeeks).toHaveLength(2);
    d1.db.close();
  });
  it('retries the same transition once and settles the short period only after Wednesday noon', async () => {
    const { env, send, payload } = setup();
    const state = await readFinanceWorkspace(env, NOW);
    const command = {
      id: 'idempotent-hybrid',
      version: state.version,
      type: 'taxi-transition',
      payload,
    };
    await executeFinanceCommand(env, command, NOW);
    expect(await executeFinanceCommand(env, command, NOW)).toMatchObject({ duplicate: true });
    await send('taxi-entry', { ...row('new', '2026-10-16T14:00:00Z'), accountId: 'cash' });
    await expect(
      send('taxi-settle', { weekKey: hybrid.effectiveAt, accountId: 'cash' }),
    ).rejects.toThrow(/відкритий/);
    const future = kyivInstant('2026-10-21', 12);
    await send(
      'taxi-settle',
      { weekKey: hybrid.effectiveAt, accountId: 'cash', amountMinor: -110000 },
      future,
    );
    await send(
      'taxi-settlement-edit',
      { weekKey: hybrid.effectiveAt, amountMinor: -100000 },
      future,
    );
    expect((await readFinanceWorkspace(env, future)).settlements[0]).toMatchObject({
      weekKey: hybrid.effectiveAt,
      amountMinor: -100000,
    });
  });
});
