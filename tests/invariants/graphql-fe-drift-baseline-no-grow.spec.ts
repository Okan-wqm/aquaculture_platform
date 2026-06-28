/**
 * GraphQL FE↔supergraph drift baseline — NO-GROW ratchet.
 *
 * scripts/ci/graphql-fe-drift.baseline.json is a burn-down ratchet of KNOWN
 * FE-document↔supergraph drifts (operations the frontend sends that the deployed
 * supergraph rejects → HTTP 400 in the browser, the exact class behind the
 * tenant-panel /graphql 400s). scripts/ci/validate-graphql-operations.mjs blocks
 * any NEW drift not in the baseline, and the baseline's own $schema says it "MUST
 * only shrink" — but NOTHING ENFORCES that: running `--update-baseline` while a
 * new drift exists silently absorbs it (count grows), re-opening the very
 * 400-class the gate exists to close.
 *
 * This invariant makes the shrink-only contract a HARD gate: the baselined-drift
 * count may only DECREASE. Lowering BASELINE_CEILING as drift is fixed is a
 * deliberate, review-visible edit; growing the baseline (silencing a new drift)
 * fails CI. Tier-3 "make it detectable".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = resolve(
  REPO_ROOT,
  'scripts/ci/graphql-fe-drift.baseline.json',
);

/**
 * High-water mark of allowed baselined FE↔supergraph drifts. RATCHET: this may
 * only ever DECREASE, in lockstep with regenerating the baseline after a fix.
 * The burn-down is COMPLETE (139→0): #650/#654/#655/#663/#665/#688 + the final
 * burndown PR implemented every FE-ahead-of-backend op. Locked at 0 — any new
 * FE↔supergraph drift now fails CI (the strongest ratchet). Raising it = silencing
 * a new drift = CI red.
 */
const BASELINE_CEILING = 0;

interface DriftBaseline {
  count: number;
  operations: ReadonlyArray<{ key: string; file: string; op: string }>;
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as DriftBaseline;

describe('graphql fe-drift baseline — no-grow ratchet', () => {
  it('count matches the operations array length (internal consistency)', () => {
    expect(baseline.count).toBe(baseline.operations.length);
  });

  it('does not exceed the ratchet ceiling — the baseline may only shrink', () => {
    expect(baseline.count).toBeLessThanOrEqual(BASELINE_CEILING);
  });

  it('every baselined operation key is unique (no duplicate masking)', () => {
    const keys = baseline.operations.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
