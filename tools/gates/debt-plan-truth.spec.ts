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
 *   - the snapshot is a pure function of the registry text (determinism);
 *   - adding a non-CRITICAL finding needs no plan edit at all (the de-churn);
 *   - the guarantee the mirror carried is checked against the derived set:
 *     an active CRITICAL with no truth-table row, a row for a CRITICAL that is
 *     no longer active, a duplicate row and an unknown bucket each fail by id;
 *   - the reconcile lane's one remaining write — retiring the row of a
 *     CRITICAL it resolved — is planned in full before anything is written,
 *     refuses rather than guess, and is idempotent.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  TRUTH_BUCKETS,
  checkDebtPlanTruth,
  deriveRegistrySnapshot,
  retireResolvedRows,
  truthTableActiveRows,
} from './debt-plan-truth';

interface Row {
  readonly id: string;
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  readonly closing_commits?: readonly string[];
}

function registry(rows: readonly Row[]): string {
  return rows
    .map((row, index) =>
      JSON.stringify({
        ...row,
        closing_commits: row.closing_commits ?? [],
        content_hash: String(index + 1).padStart(64, '0'),
      }),
    )
    .join('\n')
    .concat('\n');
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

void test('the registry snapshot is a pure function of the registry text', () => {
  const text = registry(BASE_ROWS);
  const snapshot = deriveRegistrySnapshot(text);
  assert.deepEqual(deriveRegistrySnapshot(text), snapshot);
  // Line endings and a missing trailing newline are not inputs.
  assert.deepEqual(deriveRegistrySnapshot(text.replace(/\n/g, '\r\n')), snapshot);
  assert.deepEqual(deriveRegistrySnapshot(text.trimEnd()), snapshot);

  assert.equal(snapshot.entries, 5);
  assert.equal(snapshot.open, 2);
  assert.equal(snapshot.inProgress, 2);
  assert.equal(snapshot.tipHash, '5'.padStart(64, '0'));
  assert.deepEqual(snapshot.activeCriticalIds, ['INFRA-CRITICAL-001', 'ARIA-CRITICAL-003']);
  assert.equal(snapshot.closingCommitById.get('SENSOR-CRITICAL-004'), 'abc123def4567890');
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

void test('the reconcile lane retires a resolved CRITICAL row into Resolved Evidence', () => {
  const resolved = deriveRegistrySnapshot(
    registry(
      BASE_ROWS.map((row) =>
        row.id === 'ARIA-CRITICAL-003'
          ? { ...row, state: 'RESOLVED' as const, closing_commits: ['fedcba9876543210'] }
          : row,
      ),
    ),
  );
  const { contents, retired } = retireResolvedRows(TRUTH_TABLE, resolved);
  assert.deepEqual(retired, ['ARIA-CRITICAL-003']);
  assert.doesNotMatch(contents, /^\| `ARIA-CRITICAL-003`/m);
  assert.match(
    contents,
    /^- `ARIA-CRITICAL-003`: registry state is `RESOLVED` with closing commit$/m,
  );
  assert.match(contents, /`fedcba987`, derived by `finding-registry reconcile`/);
  assert.match(contents, /Left the active table from bucket `blocked`\./);
  // Appended to the END of the Resolved Evidence section, after what was there.
  assert.ok(contents.indexOf('OLD-CRITICAL-000') < contents.indexOf('- `ARIA-CRITICAL-003`'));
  // The result satisfies the check, and a second run changes nothing.
  assert.equal(checkDebtPlanTruth(resolved, truthTableActiveRows(contents)).valid, true);
  assert.deepEqual(retireResolvedRows(contents, resolved), { contents, retired: [] });
});

void test('the reconcile lane refuses rather than guess, before writing anything', () => {
  const missing = deriveRegistrySnapshot(
    registry([...BASE_ROWS, { id: 'ADMIN-CRITICAL-008', severity: 'CRITICAL', state: 'OPEN' }]),
  );
  assert.throws(() => retireResolvedRows(TRUTH_TABLE, missing), /ADMIN-CRITICAL-008/);

  // A CRITICAL that left the active set without a closing commit (BLOCKED,
  // STALE) is a judgement the lane must not record as a resolution.
  const blocked = deriveRegistrySnapshot(
    registry(
      BASE_ROWS.map((row) =>
        row.id === 'ARIA-CRITICAL-003' ? { ...row, state: 'BLOCKED' as const } : row,
      ),
    ),
  );
  assert.throws(
    () => retireResolvedRows(TRUTH_TABLE, blocked),
    /ARIA-CRITICAL-003.*closing commit/,
  );
});
