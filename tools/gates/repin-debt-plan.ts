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
 * `active_critical_ids` is deliberately NOT rewritten. The spec compares it with
 * `toEqual`, so order is load-bearing, and a new active CRITICAL also needs a
 * truth-table row with an owner and a bucket — judgement, not arithmetic. When a
 * CRITICAL count changes this script says so and stops, rather than silently
 * producing a manifest whose id list no longer matches its own table.
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

interface RegistryEntry {
  readonly id: string;
  readonly severity: string;
  readonly state: string;
  readonly content_hash: string;
}

/** The five scalars the plan artifacts mirror, plus the id list they pin. */
interface RegistryState {
  readonly registry_tip_hash: string;
  readonly registry_entries: number;
  readonly open_findings_count: number;
  readonly in_progress_findings_count: number;
  readonly active_critical_count: number;
  readonly active_critical_ids: readonly string[];
}

/** Only the scalars — the keys `repinManifest` rewrites one by one. */
type MirroredKey = Exclude<keyof RegistryState, 'active_critical_ids'>;

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
  };
}

/** A file this run intends to rewrite, with the exact bytes it would write. */
interface PlannedWrite {
  readonly path: string;
  readonly contents: string;
}

/** Replaces `from` with `to`, refusing when the anchor is absent. */
function substituteOrThrow(raw: string, from: string, to: string, where: string): string {
  if (from === to) return raw;
  if (!raw.includes(from)) {
    throw new Error(`${where}: anchor not found — ${from}`);
  }
  return raw.replaceAll(from, to);
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

  return { write: { path, contents: raw }, changed };
}

function planTruthTable(state: RegistryState, previousTip: string): PlannedWrite {
  const path = resolve(PLAN_DIR, 'finding-truth-table.md');
  const raw = readFileSync(path, 'utf8');
  return {
    path,
    contents: substituteOrThrow(
      raw,
      previousTip,
      state.registry_tip_hash,
      'finding-truth-table.md no longer quotes the manifest tip hash',
    ),
  };
}

function planReadme(state: RegistryState, previous: RegistryState): PlannedWrite {
  const path = resolve(PLAN_DIR, 'README.md');
  let raw = readFileSync(path, 'utf8');
  const subs: ReadonlyArray<readonly [string, string]> = [
    [
      `- Registry entries: ${previous.registry_entries}`,
      `- Registry entries: ${state.registry_entries}`,
    ],
    [
      `- OPEN findings: ${previous.open_findings_count}`,
      `- OPEN findings: ${state.open_findings_count}`,
    ],
    [
      `- IN-PROGRESS findings: ${previous.in_progress_findings_count}`,
      `- IN-PROGRESS findings: ${state.in_progress_findings_count}`,
    ],
    [
      `- Active CRITICAL findings: ${previous.active_critical_count}`,
      `- Active CRITICAL findings: ${state.active_critical_count}`,
    ],
    [previous.registry_tip_hash, state.registry_tip_hash],
  ];
  for (const [from, to] of subs) {
    raw = substituteOrThrow(raw, from, to, 'README.md');
  }
  return { path, contents: raw };
}

function main(): number {
  const previous = JSON.parse(
    readFileSync(resolve(PLAN_DIR, 'manifest.json'), 'utf8'),
  ) as RegistryState;
  const state = registryState();

  // PRECONDITION — nothing below this point may run if the id list moved.
  if (JSON.stringify(previous.active_critical_ids) !== JSON.stringify(state.active_critical_ids)) {
    process.stderr.write(
      'debt-plan repin: active_critical_ids CHANGED — refusing, nothing was written.\n' +
        '  A new active CRITICAL needs a truth-table row with an owner and a bucket,\n' +
        '  and the spec compares the id list with toEqual so order is load-bearing.\n' +
        `  registry: ${JSON.stringify(state.active_critical_ids)}\n` +
        `  manifest: ${JSON.stringify(previous.active_critical_ids)}\n`,
    );
    return 1;
  }

  // PLAN EVERYTHING FIRST. Any anchor miss throws here, with the filesystem
  // untouched — see property 2 in the header.
  const manifest = planManifest(state);
  const writes: PlannedWrite[] = [
    manifest.write,
    planTruthTable(state, previous.registry_tip_hash),
    planReadme(state, previous),
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
