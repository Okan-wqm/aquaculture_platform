import { AlertSeverity } from '../alert-rule.entity';
import {
  SUPPRESSION_WINDOWS_TRANSFORMER,
  rehydrateSuppressionWindows,
  windowsSuppress,
} from '../suppression-window';

/**
 * V-S1a-2d / ALERT-3 — stored windows come back from jsonb as strings; the
 * transformer is the one place they become Dates, and the suppression rule
 * never silences CRITICAL, lets only an admin window silence HIGH.
 */
const jsonbRow = [
  {
    id: 'w1',
    name: 'maintenance',
    startTime: '2026-09-30T01:00:00.000Z',
    endTime: '2026-09-30T03:00:00.000Z',
    createdBy: 'u1',
    createdByTenantAdmin: true,
    isRecurring: false,
  },
];

describe('suppression windows', () => {
  it('rehydrates jsonb ISO strings into Dates', () => {
    // SCENARIO: the row exactly as node-postgres hands back a jsonb column.
    // EXPECTS: Date instances — `.getTime()` used to throw a TypeError here.
    const windows = SUPPRESSION_WINDOWS_TRANSFORMER.from(jsonbRow) as ReturnType<
      typeof rehydrateSuppressionWindows
    >;
    expect(windows?.[0]?.startTime).toBeInstanceOf(Date);
    expect(windows?.[0]?.endTime.toISOString()).toBe('2026-09-30T03:00:00.000Z');
  });

  it('drops an unreadable window (it silences nothing) and reads a legacy one as non-admin', () => {
    const windows = rehydrateSuppressionWindows([
      { id: 'bad', name: 'no dates' },
      { ...jsonbRow[0], createdByTenantAdmin: undefined },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.createdByTenantAdmin).toBe(false);
  });

  it('keeps an absent column absent', () => {
    expect(rehydrateSuppressionWindows(null)).toBeUndefined();
  });

  it('never silences CRITICAL; HIGH only by an admin window; lower by any', () => {
    const inside = new Date('2026-09-30T02:00:00.000Z');
    const admin = rehydrateSuppressionWindows(jsonbRow);
    const manager = rehydrateSuppressionWindows([{ ...jsonbRow[0], createdByTenantAdmin: false }]);

    expect(windowsSuppress(admin, AlertSeverity.CRITICAL, inside)).toBe(false);
    expect(windowsSuppress(admin, AlertSeverity.HIGH, inside)).toBe(true);
    expect(windowsSuppress(manager, AlertSeverity.HIGH, inside)).toBe(false);
    expect(windowsSuppress(manager, AlertSeverity.WARNING, inside)).toBe(true);
    expect(
      windowsSuppress(admin, AlertSeverity.WARNING, new Date('2026-09-30T04:00:00.000Z')),
    ).toBe(false);
  });
});
