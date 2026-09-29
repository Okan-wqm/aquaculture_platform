/**
 * Neglect is REPORTED, never transitioned — PROC-HIGH-020.
 *
 * This spec inherits the rationale of the one it replaces
 * (`finding-sweep-critical-exemption.spec.ts`), which said: "A CRITICAL never
 * auto-STALEs — silence is not resolution. The first live daily sweep staled 29
 * open CRITICALs at once and the enterprise-grade debt-plan contract refused
 * the resulting PR (#1162) — correctly: retiring unfixed critical debt by
 * timeout is the exact audit-theater class that contract exists to stop."
 *
 * That judgement was right and is now enforced one level up. The sweep is gone,
 * so there is no transition left to exempt anything from; what remains is a
 * report. And a report must do the OPPOSITE of the old exemption: an old,
 * untouched CRITICAL is precisely the row a human most needs to see, so it is
 * included here where it was excluded there. The exemption protected findings
 * from a mutation; excluding them from a report would hide them.
 *
 * The last sweep plan before removal was 604 transitions — 308 to BLOCKED
 * including 39 CRITICAL (the exemption sat after the deadline branch and never
 * covered them), 296 to STALE including 140 HIGH — against a registry that has
 * never contained a single STALE row.
 */
import { planNeglect, type Finding } from '../../tools/gates/finding-registry';

const NOW = new Date('2026-08-11T00:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const RECENT = '2026-08-10T00:00:00Z';

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'X-HIGH-001',
    severity: 'HIGH',
    state: 'OPEN',
    title: 'fixture',
    evidence: [],
    rule_violated: '',
    owner_agent: 'fixture',
    raised_in_cycle: 'fixture',
    review_file: '',
    created_at: OLD,
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: '',
    prev_hash: '',
    content_hash: '',
    ...overrides,
  };
}

const CONFIG = { staleAfterDays: 30, now: NOW };

describe('finding neglect is reported, not transitioned', () => {
  it('reports an old CRITICAL — the case the old sweep exempted', () => {
    const rows = planNeglect([finding({ id: 'X-CRITICAL-001', severity: 'CRITICAL' })], CONFIG);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('X-CRITICAL-001');
  });

  it('reports a past-deadline row whatever its severity', () => {
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
      const rows = planNeglect(
        [finding({ severity, created_at: RECENT, deadline: '2026-07-01' })],
        CONFIG,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toContain('past deadline');
    }
  });

  it('cannot be replayed into a mutation — a row carries no transition', () => {
    const rows = planNeglect([finding({})], CONFIG);
    const keys = Object.keys(rows[0] ?? {});
    expect(keys).not.toContain('toState');
    expect(keys).not.toContain('fromState');
    // The finding's own state is quoted, never owned: a `state` property here
    // would be a property a writer owns, and the authority gate forbids a
    // clock-reading function from having one.
    expect(keys).not.toContain('state');
    expect(keys).toContain('currentState');
  });

  it('leaves a RESOLVED row alone', () => {
    expect(planNeglect([finding({ state: 'RESOLVED' })], CONFIG)).toHaveLength(0);
  });

  it('brings a WAIVED row back once its review date passes, without touching its state', () => {
    const waived = finding({ state: 'WAIVED', deadline: '2026-07-01', created_at: RECENT });
    const before = JSON.parse(JSON.stringify(waived));
    const rows = planNeglect([waived], CONFIG);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toContain('waiver due for review');
    expect(rows[0]?.currentState).toBe('WAIVED');
    expect(waived).toEqual(before);
  });

  it('leaves a WAIVED row whose review date is still ahead out of the report', () => {
    const rows = planNeglect(
      [finding({ state: 'WAIVED', deadline: '2027-01-01', created_at: OLD })],
      CONFIG,
    );
    expect(rows).toHaveLength(0);
  });

  it('is a pure reader — same input, same output, input untouched', () => {
    const entries = [finding({}), finding({ id: 'X-LOW-002', severity: 'LOW' })];
    const snapshot = JSON.parse(JSON.stringify(entries));
    const first = planNeglect(entries, CONFIG);
    const second = planNeglect(entries, CONFIG);
    expect(second).toEqual(first);
    expect(entries).toEqual(snapshot);
  });
});
