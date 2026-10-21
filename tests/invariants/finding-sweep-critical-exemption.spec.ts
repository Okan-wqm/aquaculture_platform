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
import { type Finding, planSweep, type SweepConfig } from '../../tools/gates/finding-registry';
import { ZERO_HASH } from '../../tools/gates/finding-registry-chain';

const NOW = new Date('2026-08-11T00:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const CONFIG: SweepConfig = { staleAfterDays: 30, dryRun: true, now: NOW };

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'X-HIGH-001',
    severity: 'HIGH',
    state: 'OPEN',
    title: 'Sweep exemption fixture finding',
    owner_agent: 'claude',
    raised_in_cycle: 'sweep-exemption',
    created_at: OLD,
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    prev_hash: ZERO_HASH,
    content_hash: ZERO_HASH,
    ...overrides,
  };
}

describe('finding sweep critical exemption', () => {
  it('never auto-stales a CRITICAL, however old', () => {
    const actions = planSweep([finding({ id: 'X-CRITICAL-001', severity: 'CRITICAL' })], CONFIG);

    expect(actions).toEqual([]);
  });

  it('still stales an old non-critical (the rule this must not weaken)', () => {
    const actions = planSweep([finding({ id: 'X-HIGH-001', severity: 'HIGH' })], CONFIG);

    expect(actions.map((a) => a.toState)).toEqual(['STALE']);
  });

  it('still blocks a past-deadline CRITICAL (the stronger signal survives)', () => {
    // An owned row: a BLOCKED row is an override its owner_user signs, so
    // the sweep blocks only a row that names one (ARIA-MEDIUM-601).
    const actions = planSweep(
      [
        finding({
          id: 'X-CRITICAL-002',
          severity: 'CRITICAL',
          deadline: '2026-05-01',
          owner_user: 'Okan-wqm',
        }),
      ],
      CONFIG,
    );

    expect(actions.map((a) => a.toState)).toEqual(['BLOCKED']);
  });
});
