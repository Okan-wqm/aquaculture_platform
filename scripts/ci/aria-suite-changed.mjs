#!/usr/bin/env node
/**
 * Run the ARIA kernel tests a push can break, inside a time budget, queued host-wide.
 *
 * WHY THIS EXISTS. `npm run aria:test:unit` had no local counterpart, so both hooks went
 * green on a commit with four red kernel tests (RC-9, ORPHAN-HIGH-510). This is that
 * counterpart: `.husky/pre-push` runs it on every push.
 *
 * WHY A BUDGET (PROC-MEDIUM-045). The hook is the early signal, not the authority: the
 * kernel lane (.github/workflows/aria-kernel.yml) runs the whole suite, sharded, on every
 * PR that touches an ARIA surface. The hook runs on a shared production host. Its old
 * selector matched test files by the TEXT of a changed module's name and fell back to the
 * full suite when nothing matched; measured 2026-10-02, a push touching docs and a few
 * kernel modules ran 4,454 tests in 6,357 s, earlier pushes took 100 minutes to four hours,
 * and every other lane on the host waited behind them.
 *
 *   SELECT  scripts/ci/aria-import-graph.py: the static import/reference graph, in tiers —
 *           changed tests, owner tests (tests/test_<module>.py, declared surface contracts),
 *           direct importers/readers, then importers of those (depth 2). No text matching.
 *   ORDER   by tier, then cheapest estimate first, then path. Deterministic for a given
 *           tree and duration record.
 *   BUDGET  ARIA_PREPUSH_BUDGET_S (default 300). The run is the longest prefix of that
 *           order whose estimates fit; the first module always runs, and a module whose
 *           measured start would overrun the budget is not started. Everything skipped is
 *           named, with the CI lane that runs it.
 *   ESTIMATE the last measured seconds per module, kept in <git-common-dir>/
 *           aria-suite-durations.json (local, never committed); without one,
 *           MODULE_OVERHEAD_S + SECONDS_PER_TEST × the module's test functions.
 *   QUEUE   the run holds a host-wide flock (ARIA_PREPUSH_LOCK, default
 *           /tmp/aria-prepush-suite.lock) at nice 10, so concurrent pushes wait their turn
 *           instead of thrashing the host together.
 *   GATE    a change to this file, the graph or the runner runs the jest specs that pin
 *           them: the code deciding what the next push runs is tested before it ships.
 *           Those specs drive this selector, so the jest run carries ARIA_SUITE_GATE_RUN=1
 *           and a selector started inside it never starts that run again: the recursion
 *           is bounded by construction, not by every spec remembering to fake `npx`.
 *   EXIT    one exit point. Every path returns a status (or throws a Refusal) to
 *           entry(), whose caller sets process.exitCode and lets Node drain stdout.
 *           process.exit() after a write to a pipe drops whatever the pipe had
 *           not taken yet: the `--plan` JSON of a ledger change (~200 KB) arrived cut at
 *           64 KB-146 KB, and its reader parsed a truncated plan.
 *
 * ARIA_SUITE_FULL=1 runs the whole suite, unbudgeted (still queued and niced).
 * `--plan` prints the plan as JSON and runs nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = 'scripts/ci/aria-suite-changed.mjs';
const RUNNER = 'scripts/ci/aria-suite-run.sh';
const GRAPH = 'scripts/ci/aria-import-graph.py';
const GATE_FILES = [SELF, RUNNER, GRAPH];

/** Paths whose change can break something the ARIA kernel suite asserts. */
const ARIA_SURFACES = [
  'aria-kernel',
  'tools/aria-poc',
  'tools/aria-adapters',
  '.github/workflows',
  '.github/actions',
  ...GATE_FILES,
  'package.json',
];

const GATE_SPEC_DIR = 'tests/invariants';
const DEFAULT_BUDGET_S = 300;
// Measured on the shared host, 2026-10-02: 6,357 s for 4,454 tests is 1.43 s per test, and
// one scoped runner invocation of a 2-7 test module took 1.3-1.6 s end to end.
const SECONDS_PER_TEST = 1.4;
const MODULE_OVERHEAD_S = 1.5;
const DEFAULT_LOCK = '/tmp/aria-prepush-suite.lock';
const DURATIONS_FILE = 'aria-suite-durations.json';
const DURATIONS_SCHEMA = 'aria-suite-durations/v1';
const GRAPH_CACHE_FILE = 'aria-import-graph-cache.json';
const NICE = ['nice', '-n', '10'];
const TIERS = ['changed', 'owner', 'direct', 'indirect'];
const CI_LANE = '.github/workflows/aria-kernel.yml';
const GATE_RUN_ENV = 'ARIA_SUITE_GATE_RUN';

const say = (line) => process.stdout.write(`aria-suite-changed: ${line}\n`);
const warn = (line) => process.stderr.write(`aria-suite-changed: ${line}\n`);
const round1 = (seconds) => Math.round(seconds * 10) / 10;

/** A reason this run cannot go on, carried to the single exit point with its status. */
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The only place this module ends the process: see EXIT above.
process.exitCode = entry(process.argv.slice(2));

function entry(args) {
  try {
    return args[0] === '--execute' ? execute() : main(args.includes('--plan'));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    warn(error.message);
    return error.status;
  }
}

function main(planOnly) {
  const base = baseRef();
  if (base === null) {
    // Loudly: an unresolvable base means "changed" is undefined, and blocking an offline
    // push over that would be wrong.
    warn('no origin ref resolved, ARIA kernel suite SKIPPED (CI still runs it).');
    return 0;
  }
  const diff = run('git', ['diff', '--name-only', `${base}...HEAD`, '--', ...ARIA_SURFACES]);
  const files = diff === '' ? [] : diff.split('\n');
  const forceFull = process.env.ARIA_SUITE_FULL === '1';
  const budgetS = budget();
  const gateChanged = files.filter((file) => GATE_FILES.includes(file));
  const specs = gateChanged.length > 0 ? gateSpecs() : [];
  const cacheDir = gitCommonDir();
  const durationsFile = cacheDir === null ? null : join(cacheDir, DURATIONS_FILE);
  const graph = files.length === 0 || forceFull ? null : selectTests(files, cacheDir);
  const selected = graph === null ? [] : graph.selected;
  const plan = planRun(selected, loadDurations(durationsFile), budgetS);
  applyInvariantFloor(files, plan);

  if (planOnly) {
    const out = { base, files, budgetS, full: forceFull, gateSpecs: specs, selected, ...plan };
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
    return 0;
  }
  if (files.length === 0) {
    say(`no ARIA surface touched since ${base}; suite skipped.`);
    return 0;
  }

  let failed = gateChanged.length > 0 && runGateSpecs(gateChanged, specs) !== 0;
  if (forceFull) {
    say(
      `${files.length} ARIA-surface file(s) changed since ${base}; FULL suite (ARIA_SUITE_FULL=1).`,
    );
    failed = runQueued(['bash', RUNNER]) !== 0 || failed;
  } else if (plan.run.length === 0) {
    say(
      `${files.length} ARIA-surface file(s) changed since ${base}; no kernel test module ` +
        `imports or references them, kernel suite skipped (CI runs the full suite: ${CI_LANE}).`,
    );
  } else {
    report(files.length, base, budgetS, selected, plan);
    const input = JSON.stringify({ budgetS, durationsFile, run: plan.run });
    const self = fileURLToPath(import.meta.url);
    failed = runQueued([process.execPath, self, '--execute'], input) !== 0 || failed;
  }
  return failed ? 1 : 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit ${result.status}: ${result.stderr}`;
    throw new Refusal(
      1,
      `\`${command} ${args.join(' ')}\` failed (${why.trim()}); cannot decide what this push can break.`,
    );
  }
  return result.stdout.trim();
}

function resolves(ref) {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf-8' }).status === 0
  );
}

function baseRef() {
  // What the remote already has for this branch is the honest "already verified" point.
  // Falling back to origin/main covers the first push of a new branch.
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  for (const candidate of [`origin/${branch}`, 'origin/main']) {
    if (resolves(candidate)) return candidate;
  }
  return null;
}

/** Where local, uncommitted state lives: shared by every worktree of this clone. */
function gitCommonDir() {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf-8' });
  const dir = result.status === 0 ? result.stdout.trim() : '';
  return dir === '' ? null : resolve(dir);
}

function budget() {
  const raw = process.env.ARIA_PREPUSH_BUDGET_S;
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_S;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Refusal(
      2,
      `ARIA_PREPUSH_BUDGET_S must be a positive number of seconds, got "${raw}".`,
    );
  }
  return seconds;
}

/**
 * INVARIANT FLOOR (2026-10-08, evidence: PR #1892 merged with suite shard 7
 * red and main stayed red 8h46m, fixed by #1897). The import graph cannot
 * reach tests that assert over the WHOLE discovered surface set — the
 * capability-roster and surface-reachability modules discover surfaces at
 * runtime instead of importing what they cover, so a kernel-code change can
 * break them with zero import edges. Any aria_kernel/ code change pins them
 * at the FRONT of the run (execute() never budget-skips index 0), and a
 * missing-floor regression fails the plan's shape, not silently skips.
 */
const INVARIANT_FLOOR_MODULES = [
  'aria-kernel/tests/test_autonomy_evidence_status.py',
  'aria-kernel/tests/test_surface_reachability.py',
];

function applyInvariantFloor(files, plan) {
  if (!files.some((file) => file.startsWith('aria-kernel/aria_kernel/'))) return;
  const pinned = [];
  for (const path of INVARIANT_FLOOR_MODULES) {
    if (plan.run.some((entry) => entry.path === path)) continue;
    if (plan.skipped.some((entry) => entry.path === path)) {
      plan.skipped = plan.skipped.filter((entry) => entry.path !== path);
    }
    plan.run.unshift({
      path,
      tier: 0,
      reason: 'invariant floor: discovery-based surface test (PR #1892/#1897)',
      estimateS: 1.5,
    });
    pinned.push(path);
  }
  if (pinned.length > 0) {
    say(
      `invariant floor pinned to the front of the run (discovery-based, the import graph ` +
        `cannot reach them): ${pinned.join(', ')}`,
    );
  }
}

function selectTests(files, cacheDir) {
  const tracked = run('git', ['ls-files', '-z'])
    .split('\0')
    .filter((path) => path !== '');
  const args = [GRAPH, ...(cacheDir === null ? [] : ['--cache', join(cacheDir, GRAPH_CACHE_FILE)])];
  const graph = JSON.parse(
    spawnSyncChecked('python3', args, JSON.stringify({ changed: files, tracked })),
  );
  for (const entry of graph.unresolved) {
    warn(`${entry.module}: \`${entry.import}\` resolves to no module; the graph cannot place it.`);
  }
  for (const path of graph.unparsed) {
    warn(`${path} does not parse; nothing it imports is known to the selection.`);
  }
  return graph;
}

function spawnSyncChecked(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit ${result.status}`;
    throw new Refusal(1, `${args[0]} failed (${why}):\n${result.stderr}`);
  }
  return result.stdout;
}

function loadDurations(file) {
  if (file === null || !existsSync(file)) return {};
  try {
    const stored = JSON.parse(readFileSync(file, 'utf-8'));
    if (stored.schema === DURATIONS_SCHEMA && stored.seconds instanceof Object)
      return stored.seconds;
  } catch (error) {
    warn(`ignoring unreadable duration record ${file} (${error.message}).`);
  }
  return {};
}

function saveDurations(file, seconds) {
  const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => (a < b ? -1 : 1)));
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify({ schema: DURATIONS_SCHEMA, seconds: sorted })}\n`);
  renameSync(pending, file);
}

/**
 * The run: the longest prefix of the priority order that fits the budget, never empty
 * when something was selected, so a single heavy changed test still runs.
 */
function planRun(selected, durations, budgetS) {
  const estimated = selected.map((entry) => {
    const recorded = durations[entry.path];
    const estimate =
      typeof recorded === 'number' ? recorded : MODULE_OVERHEAD_S + SECONDS_PER_TEST * entry.tests;
    return {
      path: entry.path,
      tier: entry.tier,
      reason: entry.reason,
      estimateS: round1(estimate),
    };
  });
  estimated.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.estimateS - b.estimateS ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const planned = [];
  const skipped = [];
  let total = 0;
  for (const entry of estimated) {
    if (skipped.length === 0 && (planned.length === 0 || total + entry.estimateS <= budgetS)) {
      planned.push(entry);
      total += entry.estimateS;
    } else {
      skipped.push(entry);
    }
  }
  return { run: planned, skipped, estimateS: round1(total) };
}

function report(fileCount, base, budgetS, selected, plan) {
  const counts = TIERS.map((tier, index) => [tier, selected.filter((e) => e.tier === index).length])
    .filter(([, count]) => count > 0)
    .map(([tier, count]) => `${tier} ${count}`)
    .join(', ');
  say(
    `${fileCount} ARIA-surface file(s) changed since ${base}; the import graph reaches ` +
      `${selected.length} test module(s) (${counts}).`,
  );
  say(
    `budget ${budgetS} s (ARIA_PREPUSH_BUDGET_S): running ${plan.run.length} module(s), ` +
      `est. ${plan.estimateS} s; skipping ${plan.skipped.length}.`,
  );
  TIERS.forEach((tier, index) => {
    const skipped = plan.skipped.filter((entry) => entry.tier === index).map((entry) => entry.path);
    if (skipped.length === 0) return;
    // Indirect importers are the long tail: their count says enough.
    const names = tier === 'indirect' ? '' : `: ${skipped.join(', ')}`;
    say(`  skipped ${tier} (${skipped.length})${names}`);
  });
  if (plan.skipped.length > 0) say(`CI runs the full suite on this change: ${CI_LANE}.`);
}

/** The specs that name this selector by path: they pin it, so they validate a change to it. */
function gateSpecs() {
  return readdirSync(GATE_SPEC_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `${GATE_SPEC_DIR}/${name}`)
    .filter((path) => readFileSync(path, 'utf-8').includes(SELF))
    .sort();
}

function runGateSpecs(changedGate, specs) {
  if (process.env[GATE_RUN_ENV] === '1') {
    // This selector was started by one of those specs: the run that validates the gate is
    // already in progress, one level up. Starting it again is how it would never end.
    say(
      `gate changed (${changedGate.join(', ')}); already inside its spec run (${GATE_RUN_ENV}=1).`,
    );
    return 0;
  }
  if (!existsSync('node_modules/.bin/jest')) {
    warn(`jest is not installed: the specs pinning ${changedGate.join(', ')} were NOT run here.`);
    warn("  CI is their first reader. Run 'npm ci', or link node_modules into this worktree.");
    return 0;
  }
  say(
    `gate changed (${changedGate.join(', ')}); running the specs that pin it: ${specs.join(', ')}`,
  );
  const jest = ['npx', '--no', '--', 'jest', '--config', `${GATE_SPEC_DIR}/jest.config.ts`];
  const result = spawnSync(NICE[0], [...NICE.slice(1), ...jest, '--runTestsByPath', ...specs], {
    stdio: 'inherit',
    env: { ...process.env, [GATE_RUN_ENV]: '1' },
  });
  if (result.error) warn(`could not run the gate specs: ${result.error.message}`);
  return result.error ? 1 : (result.status ?? 1);
}

/** Run under the host-wide lock at low priority; concurrent pushes queue on the lock. */
function runQueued(argv, input) {
  const lock = process.env.ARIA_PREPUSH_LOCK || DEFAULT_LOCK;
  const probe = spawnSync('flock', ['--version'], { stdio: 'ignore' });
  let command;
  if (probe.error || probe.status !== 0) {
    warn('flock is unavailable: this run is NOT queued behind other pushes on this host.');
    command = [...NICE, ...argv];
  } else {
    say(`waiting for the host-wide suite lock ${lock} (concurrent pushes queue here).`);
    command = ['flock', lock, ...NICE, ...argv];
  }
  const result = spawnSync(command[0], command.slice(1), {
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    input,
  });
  if (result.error) warn(`could not start ${command[0]}: ${result.error.message}`);
  return result.error ? 1 : (result.status ?? 1);
}

/** Lock holder: run the planned modules one runner invocation each, timing every one. */
function execute() {
  const plan = JSON.parse(readFileSync(0, 'utf-8'));
  const durations = loadDurations(plan.durationsFile);
  const started = Date.now();
  const failed = [];
  let ran = 0;
  for (const [index, entry] of plan.run.entries()) {
    const elapsed = (Date.now() - started) / 1000;
    if (index > 0 && elapsed + entry.estimateS > plan.budgetS) {
      const rest = plan.run.slice(index).map((e) => e.path);
      say(
        `budget reached at ${Math.round(elapsed)} s; not started (CI runs them): ${rest.join(', ')}`,
      );
      break;
    }
    say(
      `[${index + 1}/${plan.run.length}] ${entry.path} ` +
        `(${TIERS[entry.tier]}: ${entry.reason}; est. ${entry.estimateS} s)`,
    );
    const moduleStart = Date.now();
    const result = spawnSync('bash', [RUNNER, entry.path], { stdio: 'inherit' });
    durations[entry.path] = round1((Date.now() - moduleStart) / 1000);
    ran += 1;
    if (result.error || result.status !== 0) failed.push(entry.path);
  }
  if (plan.durationsFile !== null) saveDurations(plan.durationsFile, durations);
  const wall = Math.round((Date.now() - started) / 1000);
  if (failed.length > 0) {
    warn(`${failed.length} of ${ran} module(s) FAILED in ${wall} s: ${failed.join(', ')}`);
    return 1;
  }
  say(`${ran} module(s) passed in ${wall} s.`);
  return 0;
}
