#!/usr/bin/env node
/**
 * Run the ARIA kernel unit suite, but only when this push actually touches an
 * ARIA surface.
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
 * WHY SCOPED, AND HOW. The suite executes more than 5,000 tests. Running it on
 * every push would create pressure to bypass the gate, which is worse than no
 * gate. So it fires only when the commits THIS push adds touch a surface the
 * suite asserts on. The trigger set is wider than `aria-kernel/` because the
 * suite reads `.github/workflows` (workflow contracts, SHA pinning, sandbox
 * containment) and `.github/actions` (composite actions those workflows use),
 * and both of those are how RC-9 broke it without touching a line of Python.
 *
 * WHY NOT PER-FILE. The kernel suite is all-or-nothing — there is no honest way
 * to select "the tests affected by this file", and a wrong selection reports
 * green on the tests it skipped. Scoping decides WHETHER to run, never WHICH.
 *
 * Range semantics mirror `.husky/pre-push`'s existing clippy gate: only what
 * this push adds, so a long-lived branch does not re-pay for work an earlier
 * push already verified.
 */

import { execFileSync, spawnSync } from 'node:child_process';

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
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function resolves(ref) {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).status === 0
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
process.stdout.write(
  `aria-suite-changed: ${files.length} ARIA-surface file(s) changed since ${base}; running the kernel suite.\n`,
);

// The suite runs through scripts/ci/aria-suite-run.sh — the single semantic
// partition authority for TestCase tests and pytest-native tests.
const result = spawnSync('bash', ['scripts/ci/aria-suite-run.sh'], {
  stdio: 'inherit',
  env: { ...process.env },
});

if (result.error) {
  process.stderr.write(`aria-suite-changed: could not run the suite: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
