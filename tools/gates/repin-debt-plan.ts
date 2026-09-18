#!/usr/bin/env ts-node
/**
 * Repin the enterprise-grade-debt-closure plan artifacts to the finding registry.
 *
 * The registry is the SSoT; `manifest.json`, `finding-truth-table.md` and
 * `README.md` mirror five numbers out of it. Every `findings:add` moves those
 * numbers, so the mirror has to be refreshed AFTER the last mint — and doing it
 * by hand across three files, in that order, is a trap that has now been walked
 * into twice: repin, then remember one more finding, and the plan contract goes
 * red on a number nobody chose to change.
 *
 * This makes it one idempotent command. It only rewrites the mirrored values; it
 * does not touch prose, table rows, or bucket assignments, because those carry
 * human judgement the registry does not hold.
 *
 * Correctness is verified by the thing that consumes the output:
 *   npx jest --config tests/invariants/jest.config.ts \
 *     --runTestsByPath tests/invariants/enterprise-grade-debt-plan-contract.spec.ts
 *
 * `active_critical_ids` moves in exactly one direction without a human:
 * SHRINKING. The two cases are not symmetric, and version two treated them as
 * if they were.
 *
 *   * An ADDED active CRITICAL still refuses. A new one needs a truth-table row
 *     with an owner, a deadline and a bucket — judgement, not arithmetic — and
 *     the spec compares the id list with `toEqual`, so a manifest that lists an
 *     id its own table does not carry is a lie in a file whose whole job is to
 *     be true.
 *
 *   * A REMOVED one is recorded. A CRITICAL leaves the active set because a
 *     merged commit closed it and `finding-registry reconcile` marked it
 *     RESOLVED — the most mechanical fact in this system, and the exact fact
 *     the closure-reconcile lane exists to publish. Its row leaves the active
 *     table and an entry is appended to `Resolved Evidence` naming the closing
 *     commit and the bucket it left.
 *
 * Version two refused on ANY change, which made the lane structurally unable to
 * finish its own job: reconcile would resolve a CRITICAL, and the repin two
 * steps later would refuse BECAUSE it had. Every merge closing a CRITICAL left
 * the drift gate red for the next contributor — the tax the lane was built to
 * remove, now paid on the lane's own success (ORPHAN-MEDIUM-444's failure mode
 * in a new costume).
 *
 * Three properties are load-bearing, and each one is here because its absence
 * shipped first (ORPHAN-MEDIUM-444):
 *
 *   1. The refusal is a PRECONDITION, checked before the first byte is written.
 *      Version one compared the id lists and then wrote all three files anyway,
 *      exiting non-zero afterwards — so the paragraph above was false and a
 *      refused run left the counts moved and the id list stale, which is
 *      precisely the inconsistent mirror it claims to prevent. Do not move a
 *      write above the guard.
 *   2. Every anchor miss THROWS, and every edit is PLANNED before any file is
 *      written. Version one had `repinManifest` throw while `repinTruthTable`
 *      and `repinReadme` returned a boolean the caller discarded, so a renamed
 *      README bullet or a truth-table that no longer quoted the tip hash made
 *      the script exit 0 reporting success while silently repinning nothing. A
 *      mirror-refresher that cannot fail is worse than none: it converts drift
 *      into confidence. Making the misses throw is only half the fix — throwing
 *      on the third file after writing the first two reproduces property 1's
 *      bug in a new order. So the three `plan*` functions are pure: they read,
 *      validate every anchor, and return the bytes they would write. Nothing
 *      reaches the filesystem until all three have succeeded.
 *   3. It is TypeScript, not `.mjs`, so `tools/gates/tsconfig.json` — whose
 *      `include` is `**\/*.ts` — actually type-checks it. As `.mjs` it was the
 *      one executable gate script in this directory that nothing checked.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PLAN_DIR = resolve(REPO_ROOT, 'docs/plans/2026-06-18-enterprise-grade-debt-closure');
const REGISTRY = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

/** Matches the short form the hand-written Resolved Evidence entries use. */
const SHORT_SHA_LENGTH = 9;

interface RegistryEntry {
  readonly id: string;
  readonly severity: string;
  readonly state: string;
  readonly content_hash: string;
  readonly closing_commits?: readonly string[];
}

/** The five scalars the plan artifacts mirror, plus the id list they pin. */
interface RegistryState {
  readonly registry_tip_hash: string;
  readonly registry_entries: number;
  readonly open_findings_count: number;
  readonly in_progress_findings_count: number;
  readonly active_critical_count: number;
  readonly active_critical_ids: readonly string[];
  /** Closing commit per id, for the Resolved Evidence entry a removal writes. */
  readonly closing_commit_by_id: Readonly<Record<string, string>>;
}

/** Only the scalars — the keys `repinManifest` rewrites one by one. */
type MirroredKey = Exclude<keyof RegistryState, 'active_critical_ids' | 'closing_commit_by_id'>;

const MIRRORED_KEYS: readonly MirroredKey[] = [
  'registry_tip_hash',
  'registry_entries',
  'open_findings_count',
  'in_progress_findings_count',
  'active_critical_count',
];

function registryState(): RegistryState {
  const entries = readFileSync(REGISTRY, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RegistryEntry);
  const tip = entries[entries.length - 1];
  if (!tip) throw new Error(`registry is empty: ${REGISTRY}`);
  const activeCritical = entries.filter(
    (e) => e.severity === 'CRITICAL' && (e.state === 'OPEN' || e.state === 'IN-PROGRESS'),
  );
  return {
    registry_tip_hash: tip.content_hash,
    registry_entries: entries.length,
    open_findings_count: entries.filter((e) => e.state === 'OPEN').length,
    in_progress_findings_count: entries.filter((e) => e.state === 'IN-PROGRESS').length,
    active_critical_count: activeCritical.length,
    active_critical_ids: activeCritical.map((e) => e.id),
    // Later entries supersede earlier ones: the registry is append-only, so the
    // last row carrying an id is its current state.
    closing_commit_by_id: Object.fromEntries(
      entries.flatMap((e) => {
        const commits = e.closing_commits ?? [];
        const latest = commits[commits.length - 1];
        return latest === undefined ? [] : [[e.id, latest] as const];
      }),
    ),
  };
}

/** A file this run intends to rewrite, with the exact bytes it would write. */
interface PlannedWrite {
  readonly path: string;
  readonly contents: string;
}

/** Replaces `from` with `to`, refusing when the anchor is absent. */
function substituteOrThrow(raw: string, from: string, to: string, where: string): string {
  if (!raw.includes(from)) {
    throw new Error(`${where}: anchor not found — ${from}`);
  }
  if (from === to) return raw;
  return raw.replaceAll(from, to);
}

/** Replaces exactly one governed Markdown line, regardless of its stale value. */
function replaceLineOrThrow(
  raw: string,
  pattern: RegExp,
  replacement: string,
  where: string,
): string {
  const matches = raw.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `${where}: expected exactly one governed anchor, found ${matches?.length ?? 0}`,
    );
  }
  return raw.replace(pattern, replacement);
}

/**
 * Textual edit, not `JSON.stringify`: this manifest is prettier-dirty at base
 * and a reserialize would produce hundreds of lines of unrelated churn.
 */
function planManifest(state: RegistryState): { write: PlannedWrite; changed: string[] } {
  const path = resolve(PLAN_DIR, 'manifest.json');
  let raw = readFileSync(path, 'utf8');
  const current = JSON.parse(raw) as Record<string, unknown>;
  const changed: string[] = [];

  for (const key of MIRRORED_KEYS) {
    const from = current[key];
    const to = state[key];
    if (from === to) continue;
    raw = substituteOrThrow(
      raw,
      `"${key}": ${JSON.stringify(from)}`,
      `"${key}": ${JSON.stringify(to)}`,
      `manifest.json[${key}]`,
    );
    changed.push(`${key}: ${String(from)} -> ${String(to)}`);
  }

  if (
    JSON.stringify(current['active_critical_ids']) !== JSON.stringify(state.active_critical_ids)
  ) {
    raw = planActiveCriticalIds(raw, state.active_critical_ids);
    changed.push(
      `active_critical_ids: ${(current['active_critical_ids'] as unknown[]).length} -> ${state.active_critical_ids.length}`,
    );
  }

  return { write: { path, contents: raw }, changed };
}

/**
 * Rewrites just the `active_critical_ids` array block, preserving the file's
 * two-space object / four-space element indentation. A whole-file reserialize
 * would churn hundreds of prettier-dirty lines — see planManifest's note.
 */
function planActiveCriticalIds(raw: string, ids: readonly string[]): string {
  const anchor = '  "active_critical_ids": [';
  const start = raw.indexOf(anchor);
  if (start === -1) {
    throw new Error('manifest.json[active_critical_ids]: anchor not found');
  }
  const end = raw.indexOf('\n  ]', start);
  if (end === -1) {
    throw new Error('manifest.json[active_critical_ids]: array is unterminated');
  }
  const body = ids.map((id) => `    ${JSON.stringify(id)}`).join(',\n');
  return `${raw.slice(0, start)}${anchor}\n${body}${raw.slice(end)}`;
}

/**
 * Appends an entry to the END OF THE `Resolved Evidence` SECTION, not the end of
 * the file. Those coincide today because it is the last section; writing to the
 * file's end would keep working until someone adds a section after it, and then
 * silently misfile every future closure.
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
 * Repins the tip hash, and for each CRITICAL that left the active set, lifts its
 * row out of the active table into `Resolved Evidence` — the move the two
 * entries already there were made by hand.
 */
function planTruthTable(state: RegistryState, resolved: readonly string[]): PlannedWrite {
  const path = resolve(PLAN_DIR, 'finding-truth-table.md');
  let raw = replaceLineOrThrow(
    readFileSync(path, 'utf8'),
    /^Registry tip: `(?:[0-9a-f]{64})`$/gm,
    `Registry tip: \`${state.registry_tip_hash}\``,
    'finding-truth-table.md registry tip',
  );

  for (const id of resolved) {
    const row = new RegExp(`^\\| \`${id}\`.*$\\n`, 'm');
    const match = raw.match(row);
    if (!match?.[0]) {
      throw new Error(`finding-truth-table.md: no active-table row for resolved ${id}`);
    }
    // Last cell of the pipe row is the bucket the finding is leaving.
    const cells = match[0]
      .trim()
      .split('|')
      .map((cell) => cell.trim());
    const bucket = cells[cells.length - 2] ?? 'unknown';
    const commit = state.closing_commit_by_id[id];
    if (!commit) {
      throw new Error(`finding-truth-table.md: ${id} left the active set with no closing commit`);
    }

    raw = raw.replace(row, '');
    // Wrapped to the prose width the docs gate enforces, and abbreviated to the
    // short sha the entries already there use. MD013 exempts tables and code
    // blocks; a bullet is neither, so an unwrapped line here fails docs-check.
    const entry = [
      `- \`${id}\`: registry state is \`RESOLVED\` with closing commit`,
      `  \`${commit.slice(0, SHORT_SHA_LENGTH)}\`, derived by \`finding-registry reconcile\` against \`origin/main\`.`,
      `  Left the active table from bucket \`${bucket}\`.`,
    ].join('\n');
    raw = appendToResolvedEvidence(raw, entry);
  }

  return { path, contents: raw };
}

function planReadme(state: RegistryState): PlannedWrite {
  const path = resolve(PLAN_DIR, 'README.md');
  let raw = readFileSync(path, 'utf8');
  const lines: ReadonlyArray<readonly [RegExp, string, string]> = [
    [
      /^- Registry entries: \d+$/gm,
      `- Registry entries: ${state.registry_entries}`,
      'README.md registry entries',
    ],
    [
      /^- OPEN findings: \d+$/gm,
      `- OPEN findings: ${state.open_findings_count}`,
      'README.md open findings',
    ],
    [
      /^- IN-PROGRESS findings: \d+$/gm,
      `- IN-PROGRESS findings: ${state.in_progress_findings_count}`,
      'README.md in-progress findings',
    ],
    [
      /^- Active CRITICAL findings: \d+$/gm,
      `- Active CRITICAL findings: ${state.active_critical_count}`,
      'README.md active critical findings',
    ],
    [
      /^- Registry tip hash: `(?:[0-9a-f]{64})`$/gm,
      `- Registry tip hash: \`${state.registry_tip_hash}\``,
      'README.md registry tip hash',
    ],
    [
      /^- `npm run findings:verify`: passing against registry tip `(?:[0-9a-f]{64})`$/gm,
      `- \`npm run findings:verify\`: passing against registry tip \`${state.registry_tip_hash}\``,
      'README.md findings verify tip',
    ],
  ];
  for (const [pattern, replacement, where] of lines) {
    raw = replaceLineOrThrow(raw, pattern, replacement, where);
  }
  return { path, contents: raw };
}

function main(): number {
  const previous = JSON.parse(
    readFileSync(resolve(PLAN_DIR, 'manifest.json'), 'utf8'),
  ) as RegistryState;
  const state = registryState();

  // PRECONDITION — nothing below this point may run if a CRITICAL was ADDED.
  // A removal is mechanical and is recorded below; an addition is judgement.
  const added = state.active_critical_ids.filter(
    (id) => !previous.active_critical_ids.includes(id),
  );
  if (added.length > 0) {
    process.stderr.write(
      'debt-plan repin: active CRITICAL(s) ADDED — refusing, nothing was written.\n' +
        `  added: ${JSON.stringify(added)}\n` +
        '  A new active CRITICAL needs a truth-table row with an owner, a deadline\n' +
        '  and a bucket, and the spec compares the id list with toEqual so order is\n' +
        '  load-bearing. Add the row by hand, then re-run.\n' +
        `  registry: ${JSON.stringify(state.active_critical_ids)}\n` +
        `  manifest: ${JSON.stringify(previous.active_critical_ids)}\n`,
    );
    return 1;
  }

  const resolved = previous.active_critical_ids.filter(
    (id) => !state.active_critical_ids.includes(id),
  );

  // PLAN EVERYTHING FIRST. Any anchor miss throws here, with the filesystem
  // untouched — see property 2 in the header.
  const manifest = planManifest(state);
  const writes: PlannedWrite[] = [
    manifest.write,
    planTruthTable(state, resolved),
    planReadme(state),
  ];
  for (const { path, contents } of writes) writeFileSync(path, contents, 'utf8');
  const { changed } = manifest;

  if (changed.length === 0) {
    process.stdout.write('debt-plan repin: already current\n');
  } else {
    for (const line of changed) process.stdout.write(`debt-plan repin: ${line}\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
