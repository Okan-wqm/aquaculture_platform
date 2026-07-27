#!/usr/bin/env node
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
 * That refusal is a PRECONDITION, checked before the first byte is written. The
 * first version of this file compared the id lists and then wrote all three
 * files anyway, exiting non-zero only afterwards — so the docstring above was
 * false and a refused run still left three modified files behind, with counts
 * moved and the id list stale: exactly the inconsistent mirror it claims to
 * prevent. The ordering below is the fix, and it is the only thing keeping that
 * sentence true, so do not move a write above the guard.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN_DIR = resolve(REPO_ROOT, 'docs/plans/2026-06-18-enterprise-grade-debt-closure');
const REGISTRY = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

function registryState() {
  const entries = readFileSync(REGISTRY, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const activeCritical = entries.filter(
    (e) => e.severity === 'CRITICAL' && (e.state === 'OPEN' || e.state === 'IN-PROGRESS'),
  );
  return {
    registry_tip_hash: entries[entries.length - 1].content_hash,
    registry_entries: entries.length,
    open_findings_count: entries.filter((e) => e.state === 'OPEN').length,
    in_progress_findings_count: entries.filter((e) => e.state === 'IN-PROGRESS').length,
    active_critical_count: activeCritical.length,
    active_critical_ids: activeCritical.map((e) => e.id),
  };
}

/** Textual edit, not JSON.stringify: this manifest is prettier-dirty at base and
 *  a reserialize would produce hundreds of lines of unrelated churn. */
function repinManifest(state) {
  const path = resolve(PLAN_DIR, 'manifest.json');
  let raw = readFileSync(path, 'utf8');
  const current = JSON.parse(raw);
  const changed = [];

  for (const key of [
    'registry_tip_hash',
    'registry_entries',
    'open_findings_count',
    'in_progress_findings_count',
    'active_critical_count',
  ]) {
    const from = current[key];
    const to = state[key];
    if (from === to) continue;
    const needle = `"${key}": ${JSON.stringify(from)}`;
    if (!raw.includes(needle)) {
      throw new Error(`manifest anchor not found for ${key}: ${needle}`);
    }
    raw = raw.replace(needle, `"${key}": ${JSON.stringify(to)}`);
    changed.push(`${key}: ${from} -> ${to}`);
  }

  writeFileSync(path, raw, 'utf8');
  return changed;
}

function repinTruthTable(state, previousTip) {
  const path = resolve(PLAN_DIR, 'finding-truth-table.md');
  const raw = readFileSync(path, 'utf8');
  if (!raw.includes(previousTip)) return false;
  writeFileSync(path, raw.replaceAll(previousTip, state.registry_tip_hash), 'utf8');
  return true;
}

function repinReadme(state, previous) {
  const path = resolve(PLAN_DIR, 'README.md');
  let raw = readFileSync(path, 'utf8');
  const subs = [
    [`- Registry entries: ${previous.registry_entries}`, `- Registry entries: ${state.registry_entries}`],
    [`- OPEN findings: ${previous.open_findings_count}`, `- OPEN findings: ${state.open_findings_count}`],
    [
      `- IN-PROGRESS findings: ${previous.in_progress_findings_count}`,
      `- IN-PROGRESS findings: ${state.in_progress_findings_count}`,
    ],
    [
      `- Active CRITICAL findings: ${previous.active_critical_count}`,
      `- Active CRITICAL findings: ${state.active_critical_count}`,
    ],
  ];
  for (const [from, to] of subs) {
    if (from !== to) raw = raw.replaceAll(from, to);
  }
  raw = raw.replaceAll(previous.registry_tip_hash, state.registry_tip_hash);
  writeFileSync(path, raw, 'utf8');
  return true;
}

const previous = JSON.parse(readFileSync(resolve(PLAN_DIR, 'manifest.json'), 'utf8'));
const state = registryState();

// PRECONDITION — nothing below this point may run if the id list moved. Written
// as a guard clause rather than a post-write check so a refused run leaves the
// working tree exactly as it found it.
if (
  JSON.stringify(previous.active_critical_ids) !== JSON.stringify(state.active_critical_ids)
) {
  console.error(
    'debt-plan repin: active_critical_ids CHANGED — refusing, nothing was written.\n' +
      '  A new active CRITICAL needs a truth-table row with an owner and a bucket,\n' +
      '  and the spec compares the id list with toEqual so order is load-bearing.\n' +
      `  registry: ${JSON.stringify(state.active_critical_ids)}\n` +
      `  manifest: ${JSON.stringify(previous.active_critical_ids)}`,
  );
  process.exit(1);
}

const changed = repinManifest(state);
repinTruthTable(state, previous.registry_tip_hash);
repinReadme(state, previous);

if (changed.length === 0) {
  console.log('debt-plan repin: already current');
} else {
  for (const line of changed) console.log(`debt-plan repin: ${line}`);
}
