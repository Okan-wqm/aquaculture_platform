#!/usr/bin/env ts-node

/**
 * PROC-HIGH-046 — the debt plan derives its registry snapshot; it does not
 * mirror it.
 *
 * The enterprise-grade debt plan used to record the registry tip hash, the row
 * count, the OPEN / IN-PROGRESS / active-CRITICAL counts and the active
 * CRITICAL id list in three files, rewritten by `gates:debt-plan:repin` after
 * every `findings:add`. Every registry PR touched the same lines, so any two
 * conflicted. These specs pin what replaces it:
 *
 *   - the snapshot is a pure function of the projected rows (determinism);
 *   - adding a non-CRITICAL finding needs no plan edit at all (the de-churn);
 *   - the guarantee the mirror carried is checked against the derived set:
 *     an active CRITICAL with no truth-table row, a row for a CRITICAL that is
 *     no longer active, a duplicate row and an unknown bucket each fail by id;
 *   - MF-1 (PROC-HIGH-039): nothing retires a row after a merge any more; a
 *     CRITICAL that left the active set fails as a retired row, so the PR
 *     whose trailer closes it removes the row itself (the end-to-end case
 *     through the CLI is tests/invariants/enterprise-grade-debt-plan-contract.spec.ts);
 *   - ARIA-HIGH-534: "active" is the registry's own unresolved set (OPEN,
 *     IN-PROGRESS, BLOCKED, STALE), so the daily sweep's BLOCKED transition of
 *     a past-deadline CRITICAL keeps its truth-table row valid instead of
 *     failing the sweep PR on a row that "left" the active set.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  TRUTH_BUCKETS,
  checkDebtPlanTruth,
  deriveRegistrySnapshot,
  truthTableActiveRows,
} from './debt-plan-truth';
import { planSweep } from './finding-registry';
import { type Finding, ZERO_HASH } from './finding-registry-chain';

interface Row {
  readonly id: string;
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  readonly closing_commits?: readonly string[];
}

/** A row as the projection hands it to the snapshot: chained. */
type ChainedRow = Row & { readonly content_hash: string };

function registry(rows: readonly Row[]): ChainedRow[] {
  return rows.map((row, index) => ({
    ...row,
    closing_commits: row.closing_commits ?? [],
    content_hash: String(index + 1).padStart(64, '0'),
  }));
}

const BASE_ROWS: readonly Row[] = [
  { id: 'INFRA-CRITICAL-001', severity: 'CRITICAL', state: 'OPEN' },
  { id: 'FARM-HIGH-002', severity: 'HIGH', state: 'OPEN' },
  { id: 'ARIA-CRITICAL-003', severity: 'CRITICAL', state: 'IN-PROGRESS' },
  {
    id: 'SENSOR-CRITICAL-004',
    severity: 'CRITICAL',
    state: 'RESOLVED',
    closing_commits: ['abc123def4567890'],
  },
  { id: 'PROC-MEDIUM-005', severity: 'MEDIUM', state: 'IN-PROGRESS' },
];

const TRUTH_TABLE = [
  '# Finding Truth Table',
  '',
  'Allowed truth buckets:',
  '',
  ...TRUTH_BUCKETS.map((bucket) => `- \`${bucket}\``),
  '',
  '| Finding              | Registry state | First sprint | Owner        | Truth bucket |',
  '| -------------------- | -------------- | ------------ | ------------ | ------------ |',
  '| `INFRA-CRITICAL-001` | OPEN           | 1.1          | infra-expert | real-open    |',
  '| `ARIA-CRITICAL-003`  | IN-PROGRESS    | 2.1          | claude       | blocked      |',
  '',
  '## Mutation Rules',
  '',
  '- rules',
  '',
  '## Resolved Evidence',
  '',
  '- `OLD-CRITICAL-000`: resolved long ago.',
  '',
].join('\n');

void test('the registry snapshot is a pure function of the projected rows', () => {
  const rows = registry(BASE_ROWS);
  const snapshot = deriveRegistrySnapshot(rows);
  assert.deepEqual(deriveRegistrySnapshot(rows), snapshot);

  assert.equal(snapshot.entries, 5);
  assert.equal(snapshot.open, 2);
  assert.equal(snapshot.inProgress, 2);
  assert.equal(snapshot.tipHash, '5'.padStart(64, '0'));
  assert.deepEqual(snapshot.activeCriticalIds, ['INFRA-CRITICAL-001', 'ARIA-CRITICAL-003']);
});

void test('the truth table and the derived active set agree on the fixture', () => {
  const verdict = checkDebtPlanTruth(
    deriveRegistrySnapshot(registry(BASE_ROWS)),
    truthTableActiveRows(TRUTH_TABLE),
  );
  assert.deepEqual(verdict, {
    valid: true,
    missingRows: [],
    retiredRows: [],
    duplicateRows: [],
    invalidBuckets: [],
  });
});

void test('adding a non-CRITICAL finding needs no plan edit', () => {
  const added = registry([
    ...BASE_ROWS,
    { id: 'ADMIN-HIGH-006', severity: 'HIGH', state: 'OPEN' },
    { id: 'PROC-LOW-007', severity: 'LOW', state: 'OPEN' },
  ]);
  assert.equal(
    checkDebtPlanTruth(deriveRegistrySnapshot(added), truthTableActiveRows(TRUTH_TABLE)).valid,
    true,
  );
});

void test('an active CRITICAL added without a truth-table row fails by id', () => {
  const added = registry([
    ...BASE_ROWS,
    { id: 'ADMIN-CRITICAL-008', severity: 'CRITICAL', state: 'OPEN' },
  ]);
  const verdict = checkDebtPlanTruth(
    deriveRegistrySnapshot(added),
    truthTableActiveRows(TRUTH_TABLE),
  );
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.missingRows, ['ADMIN-CRITICAL-008']);
});

void test('a row for a CRITICAL that left the active set fails by id', () => {
  const resolved = registry(
    BASE_ROWS.map((row) =>
      row.id === 'ARIA-CRITICAL-003'
        ? { ...row, state: 'RESOLVED' as const, closing_commits: ['fedcba9876543210'] }
        : row,
    ),
  );
  const verdict = checkDebtPlanTruth(
    deriveRegistrySnapshot(resolved),
    truthTableActiveRows(TRUTH_TABLE),
  );
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.retiredRows, ['ARIA-CRITICAL-003']);
});

void test('a duplicate row and an unknown bucket fail by id', () => {
  const duplicated = TRUTH_TABLE.replace(
    '| `ARIA-CRITICAL-003`  | IN-PROGRESS    | 2.1          | claude       | blocked      |',
    [
      '| `ARIA-CRITICAL-003`  | IN-PROGRESS    | 2.1          | claude       | blocked      |',
      '| `ARIA-CRITICAL-003`  | IN-PROGRESS    | 2.1          | claude       | blocked      |',
    ].join('\n'),
  ).replace('| infra-expert | real-open    |', '| infra-expert | maybe-later  |');
  const verdict = checkDebtPlanTruth(
    deriveRegistrySnapshot(registry(BASE_ROWS)),
    truthTableActiveRows(duplicated),
  );
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.duplicateRows, ['ARIA-CRITICAL-003']);
  assert.deepEqual(verdict.invalidBuckets, [{ id: 'INFRA-CRITICAL-001', bucket: 'maybe-later' }]);
});

void test('a BLOCKED or STALE CRITICAL is unresolved debt and keeps its truth-table row', () => {
  const judged = deriveRegistrySnapshot(
    registry(
      BASE_ROWS.map((row) => {
        if (row.id === 'ARIA-CRITICAL-003') return { ...row, state: 'BLOCKED' as const };
        if (row.id === 'INFRA-CRITICAL-001') return { ...row, state: 'STALE' as const };
        return row;
      }),
    ),
  );
  assert.deepEqual(judged.activeCriticalIds, ['INFRA-CRITICAL-001', 'ARIA-CRITICAL-003']);
  // BLOCKED and STALE are judgements, not resolutions: the rows stay valid.
  assert.equal(checkDebtPlanTruth(judged, truthTableActiveRows(TRUTH_TABLE)).valid, true);
});

function finding(row: Row, overrides: Partial<Finding>): Finding {
  return {
    ...row,
    title: row.id,
    owner_agent: 'claude',
    raised_in_cycle: 'spec',
    created_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    closing_commits: [...(row.closing_commits ?? [])],
    deadline: null,
    owner_user: null,
    override_of: null,
    prev_hash: ZERO_HASH,
    content_hash: ZERO_HASH,
    ...overrides,
  };
}

void test("the sweep's past-deadline BLOCKED transition passes the debt-plan gate (ARIA-HIGH-534)", () => {
  // An owned row: the sweep blocks a lapsed row only when it names an
  // owner_user to sign the override (ARIA-MEDIUM-601).
  const entries = BASE_ROWS.map((row) =>
    finding(
      row,
      row.id === 'INFRA-CRITICAL-001' ? { deadline: '2026-02-01', owner_user: 'Okan-wqm' } : {},
    ),
  );
  const actions = planSweep(entries, {
    staleAfterDays: 30,
    dryRun: false,
    now: new Date('2026-10-16T00:00:00Z'),
  });
  // The sweep does move the past-deadline CRITICAL (and only staleness moves
  // the non-CRITICAL rows).
  assert.deepEqual(
    actions.filter((action) => action.id === 'INFRA-CRITICAL-001'),
    [
      {
        id: 'INFRA-CRITICAL-001',
        fromState: 'OPEN',
        toState: 'BLOCKED',
        reason: 'past deadline 2026-02-01',
      },
    ],
  );
  const swept = entries.map((entry) => {
    const action = actions.find((candidate) => candidate.id === entry.id);
    return action === undefined ? entry : { ...entry, state: action.toState };
  });
  const verdict = checkDebtPlanTruth(
    deriveRegistrySnapshot(swept),
    truthTableActiveRows(TRUTH_TABLE),
  );
  assert.deepEqual(verdict, {
    valid: true,
    missingRows: [],
    retiredRows: [],
    duplicateRows: [],
    invalidBuckets: [],
  });
});
