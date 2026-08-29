#!/usr/bin/env node
/**
 * Run the ARIA kernel suite, but only when this push actually touches an
 * ARIA surface — and only the tests that surface can break.
 *
 * WHY THIS EXISTS. `npm run aria:test:unit` runs in CI
 * (`.github/workflows/aria-operational-proof.yml`) and had no local counterpart
 * of any kind. `.husky/pre-commit` mirrors the format gates and `.husky/pre-push`
 * mirrors the changed-file type gate, so both hooks could go green on a commit
 * that broke four Python tests — which is exactly what happened on this branch:
 * RC-9 was committed and PUSHED with `test_every_actions_use_is_sha_pinned`,
 * `test_i_sbx_01_and_02_dispatching_workflows_declare_containment` and both
 * workflow-preflight contract tests red, because I ran jest and not the kernel
 * suite. CLAUDE.md's "never commit with red tests" was enforced by intention
 * only. ORPHAN-HIGH-510.
 *
 * AFFECTED-ONLY (operator decision 2026-08-28): the gate used to answer "did
 * an ARIA surface change?" with yes/no and on yes run ALL 5048+ tests — ~2.5
 * hours on the shared runner, for a one-line workflow edit. The operator
 * relaxed the rule: the pre-push gate runs only the tests the changed files
 * can mechanically reach; the FULL suite remains the CI lanes' job
 * (aria-kernel / aria-kernel-fast, 60-minute budgets). Selection is
 * deliberately over-inclusive, never under-inclusive:
 *
 *   - `aria-kernel/aria_kernel/<mod>.py` → its conventional test module
 *     (`tests/test_<mod>.py`) PLUS every test module whose text mentions the
 *     module basename (importers, comment references — a false extra costs a
 *     few seconds; a missed importer costs a red main).
 *   - `aria-kernel/tests/<t>.py` → that module itself.
 *   - `tools/aria-poc/<tool>.py` → test modules mentioning the tool basename.
 *   - `.github/workflows` / `.github/actions` → the workflow-contract test
 *     modules, DISCOVERED by grepping the test tree for `.github/` readers
 *     (no hand-kept list to drift).
 *   - `scripts/ci/aria-suite-*`, `package.json` → the gates themselves; their
 *     execution IS their test. CI still runs the full suite on them.
 *
 * SAFETY FLOOR: a kernel-code change that maps to ZERO selected modules falls
 * back to the FULL suite — a mapping hole must cost time, never coverage.
 * ARIA_SUITE_FULL=1 forces the full suite for release-grade pushes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** Paths whose change can break something the ARIA kernel suite asserts. */
const ARIA_SURFACES = [
  'aria-kernel',
  'tools/aria-poc',
  '.github/workflows',
  '.github/actions',
  'scripts/ci/aria-suite-changed.mjs',
  'scripts/ci/aria-suite-run.sh',
  'package.json',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function resolves(ref) {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf-8' }).status === 0
  );
}

function baseRef() {
  // What the remote already has for this branch is the honest "already
  // verified" point. Falling back to origin/main covers the first push of a
  // new branch, where everything on it is new.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  for (const candidate of [`origin/${branch}`, 'origin/main']) {
    if (resolves(candidate)) return candidate;
  }
  return null;
}

const base = baseRef();
if (base === null) {
  // Loudly, not silently: an unresolvable base means "changed" is undefined,
  // and blocking an offline push over that would be wrong. Saying so is the
  // difference between a skipped gate and an invisible one.
  process.stderr.write(
    'aria-suite-changed: no origin ref resolved, ARIA kernel suite SKIPPED (CI still runs it).\n',
  );
  process.exit(0);
}

const changed = git(['diff', '--name-only', `${base}...HEAD`, '--', ...ARIA_SURFACES]);
if (changed === '') {
  process.stdout.write(
    `aria-suite-changed: no ARIA surface touched since ${base}; suite skipped.\n`,
  );
  process.exit(0);
}

const files = changed.split('\n');
const forceFull = process.env.ARIA_SUITE_FULL === '1';
const selected = forceFull ? null : selectAffectedTests(files);

if (selected === null) {
  process.stdout.write(
    `aria-suite-changed: ${files.length} ARIA-surface file(s) changed since ${base}; running the FULL kernel suite${forceFull ? ' (ARIA_SUITE_FULL=1)' : ''}.\n`,
  );
} else if (selected.size === 0 && files.some((f) => f.startsWith('scripts/ci/'))) {
  // GATE SELF-VALIDATION (pinned by aria-doc-runtime-ssot's selector test):
  // a change to the selector or the runner itself runs the runner WITH NO
  // ARGUMENTS — the full suite — because next push is trusting this exact
  // code to decide what runs. A gate that skips validating itself is a gate
  // nobody checked.
  process.stdout.write(
    `aria-suite-changed: gate surface changed since ${base}; running the FULL suite (gate self-validation).\n`,
  );
} else if (selected.size === 0) {
  process.stdout.write(
    `aria-suite-changed: ${files.length} gate/script surface file(s) changed since ${base}; no kernel tests mechanically reachable, suite skipped (CI still runs the full suite).\n`,
  );
  process.exit(0);
} else {
  const names = [...selected].sort().join(', ');
  process.stdout.write(
    `aria-suite-changed: ${files.length} ARIA-surface file(s) changed since ${base}; running ${selected.size} affected test module(s): ${names}\n`,
  );
}

const result = spawnSync(
  'bash',
  ['scripts/ci/aria-suite-run.sh', ...(selected === null ? [] : [...selected].sort())],
  {
    stdio: 'inherit',
    env: { ...process.env },
  },
);

if (result.error) {
  process.stderr.write(`aria-suite-changed: could not run the suite: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

/**
 * Map changed files to the kernel test modules they can mechanically reach.
 * Returns null when the honest answer is "all of them" (kernel-code change
 * the mapping cannot place), an empty set when the change is gate-internal.
 */
function selectAffectedTests(files) {
  const testsDir = 'aria-kernel/tests';
  if (!existsSync(testsDir)) return null;
  const testFiles = readdirSync(testsDir).filter((name) => /^test_.*\.py$/.test(name));
  const testTexts = new Map(
    testFiles.map((name) => [name, readFileSync(`${testsDir}/${name}`, 'utf-8')]),
  );

  const selected = new Set();
  let kernelCodeChanged = false;

  const addByToken = (token) => {
    for (const [name, text] of testTexts) {
      if (text.includes(token)) selected.add(name);
    }
  };

  for (const file of files) {
    if (file.startsWith('aria-kernel/tests/')) {
      const name = file.slice('aria-kernel/tests/'.length);
      if (testTexts.has(name)) selected.add(name);
      continue;
    }
    if (file.startsWith('aria-kernel/aria_kernel/')) {
      kernelCodeChanged = true;
      const stem = file.slice('aria-kernel/aria_kernel/'.length).replace(/\.py$/, '');
      const conventional = `test_${stem.split('/').pop()}.py`;
      if (testTexts.has(conventional)) selected.add(conventional);
      // Over-inclusive on purpose: importers AND textual referencers.
      addByToken(stem.split('/').pop());
      continue;
    }
    if (file.startsWith('tools/aria-poc/')) {
      kernelCodeChanged = true;
      const stem = file.slice('tools/aria-poc/'.length).replace(/\.py$/, '').split('/').pop();
      addByToken(stem);
      continue;
    }
    if (file.startsWith('.github/workflows') || file.startsWith('.github/actions')) {
      // The workflow-contract modules: discovered, never hand-listed.
      for (const [name, text] of testTexts) {
        if (text.includes('.github/workflows') || text.includes('.github/actions')) {
          selected.add(name);
        }
      }
      continue;
    }
    // scripts/ci/aria-suite-*, package.json: the gates themselves — no kernel
    // test mechanically reaches them; CI covers the full suite on them.
  }

  // SAFETY FLOOR: kernel code changed but nothing was selected — the mapping
  // has a hole. Burn the time; never ship the hole.
  if (kernelCodeChanged && selected.size === 0) return null;
  return selected;
}
