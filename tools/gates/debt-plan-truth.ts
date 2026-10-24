#!/usr/bin/env ts-node
/**
 * The enterprise-grade debt plan's registry view — derived where it is read.
 *
 * WHAT THIS MODULE ANSWERS
 *
 *   1. `deriveRegistrySnapshot(rows)` — the registry tip hash, row count,
 *      OPEN / IN-PROGRESS counts and the active CRITICAL ids (every
 *      unresolved state — OPEN, IN-PROGRESS, BLOCKED, STALE — in registry
 *      order, per `isUnresolvedFindingState`), as a pure function of the
 *      projected rows (finding-registry-projection.ts).
 *   2. `checkDebtPlanTruth(snapshot, rows)` — does the truth table's active
 *      table cover exactly that active CRITICAL set? Four ways to fail, each
 *      naming ids: an active CRITICAL with no row (`missingRows`: a new one
 *      needs an owner, a first sprint and a truth bucket — human judgement), a
 *      row whose CRITICAL is no longer active (`retiredRows`), the same id on
 *      two rows (`duplicateRows`), and a bucket outside the closed vocabulary.
 *
 * WHY THE PROJECTION (MF-1, PROC-HIGH-039). RESOLVED is derived from merged
 * `Closes:` trailers at read time, so a CRITICAL leaves the active set in the
 * tree of the PR whose trailer closes it. That PR therefore deletes the
 * CRITICAL's active row itself, and the check names a kept row on that PR,
 * not on main after a second commit. The reconcile lane used to retire the
 * row after the merge — a second writer on main — and nothing does now. The
 * `Resolved Evidence` section stays as frozen history; `--resolved` derives
 * the closer of every resolved CRITICAL instead of a hand-written row.
 *
 * WHY DERIVED AT ALL (PROC-HIGH-046). The plan used to RECORD the five
 * registry scalars and the active id list in manifest.json, README.md and
 * finding-truth-table.md, and `gates:debt-plan:repin` rewrote them after
 * every `findings:add`, so every PR that added a finding rewrote the same
 * lines as every other. The part that carried judgement is the active
 * CRITICAL set against the truth table, and that is what is compared,
 * against the registry itself instead of a copy of it.
 *
 * CLI:
 *   ts-node tools/gates/debt-plan-truth.ts             # print the snapshot, check, exit 0/1
 *   ts-node tools/gates/debt-plan-truth.ts --resolved  # every resolved CRITICAL and its closer
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isUnresolvedFindingState } from './finding-registry-chain';
import { projectRegistry } from './finding-registry-projection';

export const DEBT_PLAN_DIR = 'docs/plans/2026-06-18-enterprise-grade-debt-closure';
export const TRUTH_TABLE_PATH = `${DEBT_PLAN_DIR}/finding-truth-table.md`;

export const TRUTH_BUCKETS = [
  'real-open',
  'already-fixed-needs-close',
  'superseded',
  'blocked',
  'stale',
  'new-finding-required',
] as const;

/**
 * Manifest keys that mirrored the registry until PROC-HIGH-046. The plan
 * contract refuses them, so the mirror cannot come back as a committed value.
 */
export const DERIVED_MANIFEST_KEYS = [
  'registry_tip_hash',
  'registry_entries',
  'open_findings_count',
  'in_progress_findings_count',
  'active_critical_count',
  'active_critical_ids',
] as const;

interface RegistryRow {
  readonly id: string;
  readonly severity: string;
  readonly state: string;
  readonly content_hash: string;
}

export interface RegistrySnapshot {
  readonly tipHash: string;
  readonly entries: number;
  readonly open: number;
  readonly inProgress: number;
  readonly activeCriticalIds: readonly string[];
}

export function deriveRegistrySnapshot(rows: readonly RegistryRow[]): RegistrySnapshot {
  const tip = rows[rows.length - 1];
  if (tip === undefined) throw new Error('the finding registry is empty');
  return {
    tipHash: tip.content_hash,
    entries: rows.length,
    open: rows.filter((row) => row.state === 'OPEN').length,
    inProgress: rows.filter((row) => row.state === 'IN-PROGRESS').length,
    activeCriticalIds: rows
      // Active = still owed. A BLOCKED or STALE CRITICAL keeps its row: the
      // sweep's past-deadline BLOCKED is a judgement, not a resolution
      // (ARIA-HIGH-534), and the `blocked` / `stale` buckets exist for it.
      .filter((row) => row.severity === 'CRITICAL' && isUnresolvedFindingState(row.state))
      .map((row) => row.id),
  };
}

export interface TruthTableRow {
  readonly id: string;
  readonly bucket: string;
  /** 1-based line number in the truth table. */
  readonly line: number;
}

/**
 * Every five-cell pipe row whose first cell is a backticked id — whatever the
 * id, so a non-CRITICAL row in the active table surfaces as a retired row
 * instead of being skipped.
 */
export function truthTableActiveRows(truthTable: string): TruthTableRow[] {
  const rows: TruthTableRow[] = [];
  truthTable.split(/\r?\n/).forEach((line, index) => {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    const [first, , , , bucket] = cells;
    if (cells.length !== 5 || first === undefined || bucket === undefined) return;
    if (!first.startsWith('`')) return;
    rows.push({ id: first.replace(/^`|`$/g, ''), bucket, line: index + 1 });
  });
  return rows;
}

export interface DebtPlanVerdict {
  readonly valid: boolean;
  readonly missingRows: readonly string[];
  readonly retiredRows: readonly string[];
  readonly duplicateRows: readonly string[];
  readonly invalidBuckets: readonly { readonly id: string; readonly bucket: string }[];
}

export function checkDebtPlanTruth(
  snapshot: RegistrySnapshot,
  rows: readonly TruthTableRow[],
): DebtPlanVerdict {
  const active = new Set(snapshot.activeCriticalIds);
  const seen = new Set<string>();
  const duplicateRows: string[] = [];
  for (const row of rows) {
    if (seen.has(row.id) && !duplicateRows.includes(row.id)) duplicateRows.push(row.id);
    seen.add(row.id);
  }
  const missingRows = snapshot.activeCriticalIds.filter((id) => !seen.has(id));
  const retiredRows = [...seen].filter((id) => !active.has(id));
  const buckets: ReadonlySet<string> = new Set(TRUTH_BUCKETS);
  const invalidBuckets = rows
    .filter((row) => !buckets.has(row.bucket))
    .map((row) => ({ id: row.id, bucket: row.bucket }));
  return {
    valid:
      missingRows.length === 0 &&
      retiredRows.length === 0 &&
      duplicateRows.length === 0 &&
      invalidBuckets.length === 0,
    missingRows,
    retiredRows,
    duplicateRows,
    invalidBuckets,
  };
}

function main(argv: readonly string[]): number {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--resolved')) {
    process.stderr.write('usage: debt-plan-truth.ts [--resolved]\n');
    return 2;
  }
  const repoRoot = resolve(__dirname, '..', '..');
  const rows = projectRegistry(repoRoot);

  if (argv[0] === '--resolved') {
    for (const row of rows) {
      if (row.severity !== 'CRITICAL' || row.state !== 'RESOLVED') continue;
      process.stdout.write(`${row.id}\t${row.closing_commits.join(',')}\t${row.closed_at ?? ''}\n`);
    }
    return 0;
  }

  const snapshot = deriveRegistrySnapshot(rows);
  const truthTable = readFileSync(resolve(repoRoot, TRUTH_TABLE_PATH), 'utf8');
  process.stdout.write(
    [
      `Registry tip hash: ${snapshot.tipHash}`,
      `Registry entries: ${snapshot.entries}`,
      `OPEN findings: ${snapshot.open}`,
      `IN-PROGRESS findings: ${snapshot.inProgress}`,
      `Active CRITICAL findings: ${snapshot.activeCriticalIds.length}`,
      '',
    ].join('\n'),
  );
  const verdict = checkDebtPlanTruth(snapshot, truthTableActiveRows(truthTable));
  if (verdict.valid) {
    process.stdout.write('debt-plan truth: the active table matches the active CRITICAL set\n');
    return 0;
  }
  process.stderr.write(
    [
      'debt-plan truth: the active table does not match the registry',
      ...verdict.missingRows.map(
        (id) => `  - ${id}: active CRITICAL with no row (add owner, sprint, bucket)`,
      ),
      ...verdict.retiredRows.map((id) => `  - ${id}: row for a CRITICAL that is no longer active`),
      ...verdict.duplicateRows.map((id) => `  - ${id}: more than one row`),
      ...verdict.invalidBuckets.map(({ id, bucket }) => `  - ${id}: unknown bucket '${bucket}'`),
      '',
    ].join('\n'),
  );
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
