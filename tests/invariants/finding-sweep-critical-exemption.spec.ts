/**
 * A CRITICAL never auto-STALEs — silence is not resolution.
 *
 * The first live daily sweep staled 29 open CRITICALs at once and the
 * enterprise-grade debt-plan contract refused the resulting PR (#1162) —
 * correctly: retiring unfixed critical debt by timeout is the exact
 * audit-theater class that contract exists to stop. A critical leaves
 * OPEN through a fix commit's Closes:, an explicit waiver, or the
 * past-deadline BLOCKED branch — never through the calendar.
 */
import { planSweep } from '../../tools/gates/finding-registry';

const NOW = new Date('2026-08-11T00:00:00Z');
const OLD = '2026-01-01T00:00:00Z';

function finding(overrides: Record<string, unknown>) {
  return {
    id: 'X-HIGH-001',
    severity: 'HIGH',
    state: 'OPEN',
    created_at: OLD,
    ...overrides,
  } as never;
}

describe('finding sweep critical exemption', () => {
  it('never auto-stales a CRITICAL, however old', () => {
    const actions = planSweep([finding({ id: 'X-CRITICAL-001', severity: 'CRITICAL' })], {
      staleAfterDays: 30,
      now: NOW,
    } as never);

    expect(actions).toEqual([]);
  });

  it('still stales an old non-critical (the rule this must not weaken)', () => {
    const actions = planSweep([finding({ id: 'X-HIGH-001', severity: 'HIGH' })], {
      staleAfterDays: 30,
      now: NOW,
    } as never);

    expect(actions.map((a: { toState: string }) => a.toState)).toEqual(['STALE']);
  });

  it('still blocks a past-deadline CRITICAL (the stronger signal survives)', () => {
    const actions = planSweep(
      [finding({ id: 'X-CRITICAL-002', severity: 'CRITICAL', deadline: '2026-05-01' })],
      { staleAfterDays: 30, now: NOW } as never,
    );

    expect(actions.map((a: { toState: string }) => a.toState)).toEqual(['BLOCKED']);
  });
});
