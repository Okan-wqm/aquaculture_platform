#!/usr/bin/env ts-node
/**
 * The enterprise-grade debt plan's registry view — derived where it is read.
 *
 * WHAT THIS MODULE ANSWERS
 *
 *   1. `deriveRegistrySnapshot(registryText)` — the registry tip hash, row
 *      count, OPEN / IN-PROGRESS counts and the active CRITICAL ids (OPEN or
 *      IN-PROGRESS, in registry order), as a pure function of the registry.
 *   2. `checkDebtPlanTruth(snapshot, rows)` — does the truth table's active
 *      table cover exactly that active CRITICAL set? Four ways to fail, each
 *      naming ids: an active CRITICAL with no row (`missingRows`: a new one
 *      needs an owner, a first sprint and a truth bucket — human judgement), a
 *      row whose CRITICAL is no longer active (`retiredRows`), the same id on
 *      two rows (`duplicateRows`), and a bucket outside the closed vocabulary.
 *   3. `retireResolvedRows(truthTable, snapshot)` — the one write left: the
 *      reconcile lane, which is the only writer of RESOLVED, moves the row of
 *      each CRITICAL it resolved into `Resolved Evidence`.
 *
 * WHY (PROC-HIGH-046). The plan used to RECORD the five registry scalars and
 * the active id list in manifest.json, README.md and finding-truth-table.md,
 * and `gates:debt-plan:repin` rewrote them after every `findings:add`. So every
 * PR that added a finding rewrote the same lines as every other: 78 of 78
 * registry merges on main in the fortnight before did, and 53 merge commits
 * record hand-resolved conflicts in those three files. The scalars protected
 * nothing beyond themselves — the registry and the plan share one CODEOWNERS
 * entry, so a mirror adds no review. The part that carried judgement is the
 * active CRITICAL set against the truth table, and that is what is compared,
 * against the registry itself instead of a copy of it.
 *
 * The retirement keeps the three properties ORPHAN-MEDIUM-444/448 put into the
 * old repin: the refusal is a precondition checked before any write, every
 * anchor miss throws, and the whole result is planned before the file is
 * written.
 *
 * CLI:
 *   ts-node tools/gates/debt-plan-truth.ts                    # print the snapshot, check, exit 0/1
 *   ts-node tools/gates/debt-plan-truth.ts --retire-resolved  # the reconcile lane's write
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';
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

/** Matches the short form the hand-written Resolved Evidence entries use. */
const SHORT_SHA_LENGTH = 9;

interface RegistryRow {
  readonly id: string;
  readonly severity: string;
  readonly state: string;
  readonly content_hash: string;
  readonly closing_commits?: readonly string[];
}

export interface RegistrySnapshot {
  readonly tipHash: string;
  readonly entries: number;
  readonly open: number;
  readonly inProgress: number;
  readonly activeCriticalIds: readonly string[];
  /** Latest closing commit per id; the registry is append-only, the last row wins. */
  readonly closingCommitById: ReadonlyMap<string, string>;
}

function isActive(row: RegistryRow): boolean {
  return row.state === 'OPEN' || row.state === 'IN-PROGRESS';
}

export function deriveRegistrySnapshot(registryText: string): RegistrySnapshot {
  const rows = registryText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RegistryRow);
  const tip = rows[rows.length - 1];
  if (tip === undefined) throw new Error(`registry is empty: ${REGISTRY_PATH}`);
  const closingCommitById = new Map<string, string>();
  for (const row of rows) {
    const latest = row.closing_commits?.[row.closing_commits.length - 1];
    if (latest !== undefined) closingCommitById.set(row.id, latest);
  }
  return {
    tipHash: tip.content_hash,
    entries: rows.length,
    open: rows.filter((row) => row.state === 'OPEN').length,
    inProgress: rows.filter((row) => row.state === 'IN-PROGRESS').length,
    activeCriticalIds: rows
      .filter((row) => row.severity === 'CRITICAL' && isActive(row))
      .map((row) => row.id),
    closingCommitById,
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

/**
 * Appends to the END OF THE `Resolved Evidence` SECTION, not the end of the
 * file: they coincide today, and writing to the file's end would silently
 * misfile every closure once a section is added after it.
 */
function appendToResolvedEvidence(raw: string, entry: string): string {
  const heading = '\n## Resolved Evidence\n';
  const start = raw.indexOf(heading);
  if (start === -1) {
    throw new Error('finding-truth-table.md: no `## Resolved Evidence` section to append to');
  }
  const afterHeading = start + heading.length;
  const nextHeading = raw.indexOf('\n## ', afterHeading);
  const sectionEnd = nextHeading === -1 ? raw.length : nextHeading;
  const section = raw.slice(afterHeading, sectionEnd);
  return `${raw.slice(0, afterHeading)}${section.trimEnd()}\n${entry}\n${raw.slice(sectionEnd)}`;
}

/**
 * Moves the row of every CRITICAL that left the active set into `Resolved
 * Evidence`, naming its closing commit and the bucket it left. Pure: returns
 * the bytes to write. Refuses — throws before anything is written — when the
 * table is wrong in a way only a human can fix: an active CRITICAL with no
 * row, a duplicate row, an unknown bucket, or a CRITICAL that left the active
 * set without a closing commit (BLOCKED or STALE is a judgement, not a
 * resolution).
 */
export function retireResolvedRows(
  truthTable: string,
  snapshot: RegistrySnapshot,
): { readonly contents: string; readonly retired: readonly string[] } {
  const verdict = checkDebtPlanTruth(snapshot, truthTableActiveRows(truthTable));
  const judgement = [
    ...verdict.missingRows.map((id) => `${id} is an active CRITICAL with no truth-table row`),
    ...verdict.duplicateRows.map((id) => `${id} has more than one truth-table row`),
    ...verdict.invalidBuckets.map(({ id, bucket }) => `${id} has unknown bucket '${bucket}'`),
    ...verdict.retiredRows
      .filter((id) => !snapshot.closingCommitById.has(id))
      .map((id) => `${id} left the active set with no closing commit`),
  ];
  if (judgement.length > 0) {
    throw new Error(
      `debt-plan truth table needs a human edit; nothing was written:\n  ${judgement.join('\n  ')}`,
    );
  }

  let raw = truthTable;
  for (const id of verdict.retiredRows) {
    const row = new RegExp(`^\\|\\s*\`${id}\`.*\\r?\\n`, 'm');
    const match = raw.match(row);
    if (match?.[0] === undefined) throw new Error(`finding-truth-table.md: no row for ${id}`);
    const bucket = truthTableActiveRows(match[0])[0]?.bucket ?? 'unknown';
    const commit = snapshot.closingCommitById.get(id) ?? '';
    raw = raw.replace(row, '');
    // Wrapped to the prose width docs-check enforces (MD013 exempts tables,
    // not bullets), with the short sha the existing entries use.
    raw = appendToResolvedEvidence(
      raw,
      [
        `- \`${id}\`: registry state is \`RESOLVED\` with closing commit`,
        `  \`${commit.slice(0, SHORT_SHA_LENGTH)}\`, derived by \`finding-registry reconcile\` against \`origin/main\`.`,
        `  Left the active table from bucket \`${bucket}\`.`,
      ].join('\n'),
    );
  }
  return { contents: raw, retired: verdict.retiredRows };
}

function main(argv: readonly string[]): number {
  if (argv.some((arg) => arg !== '--retire-resolved')) {
    process.stderr.write('usage: debt-plan-truth.ts [--retire-resolved]\n');
    return 2;
  }
  const repoRoot = resolve(__dirname, '..', '..');
  const truthTablePath = resolve(repoRoot, TRUTH_TABLE_PATH);
  const snapshot = deriveRegistrySnapshot(readFileSync(resolve(repoRoot, REGISTRY_PATH), 'utf8'));
  const truthTable = readFileSync(truthTablePath, 'utf8');

  if (argv.includes('--retire-resolved')) {
    try {
      const { contents, retired } = retireResolvedRows(truthTable, snapshot);
      if (retired.length === 0) {
        process.stdout.write('debt-plan truth: no resolved CRITICAL row to retire\n');
        return 0;
      }
      writeFileSync(truthTablePath, contents, 'utf8');
      process.stdout.write(`debt-plan truth: retired ${retired.join(', ')}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

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
