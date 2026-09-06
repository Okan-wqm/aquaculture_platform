#!/usr/bin/env ts-node
/**
 * Plan ARIA-V4 §2g — runner for the narrative-prompt lint.
 *
 * The lint itself has existed for months and was invoked by nothing: not
 * package.json, not a workflow, not `run-all.mjs`, which globs `*.spec.ts` in
 * this directory and therefore never saw a bare CLI. That is why its token
 * budget could silently diverge from the kernel table it duplicates —
 * a flat 2000 against the validator's tiered 1500/2800/3500 — and why the
 * divergence was invisible: had anyone run it, six Tier-3 prompts would have
 * failed on a rule the SSoT says they satisfy.
 *
 * This file is the runner, deliberately shaped so the glob finds it: a gate
 * nothing invokes is not a gate. It smoke-tests the live binary end to end
 * (exit code + output), the same way banned-phrase.spec.ts pins its scanner.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

const LINT = resolve(REPO_ROOT, 'tools/gates/narrative-prompt-lint.ts');

function runLint(): { status: number; output: string } {
  try {
    const output = execFileSync(
      'npx',
      ['ts-node', '--project', 'tools/gates/tsconfig.json', LINT],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

void test('every ARIA agent prompt passes the pedagogy contract', () => {
  const { status, output } = runLint();
  assert.equal(status, 0, `narrative-prompt-lint failed:\n${output}`);
  assert.match(output, /pass the Plan ARIA-V4 pedagogy contract/u);
});

void test('the token budget is read from the kernel validator, not restated here', () => {
  // Pin the DERIVATION, not the numbers: this spec stays correct when the SSoT
  // is retuned, and fails the moment someone reintroduces a local constant.
  const source = readFileSync(LINT, 'utf8');
  assert.match(source, /narrative_prompt_validator\.py/u);
  // Anchored: the docblock above quotes the retired constant to explain the
  // defect, and prose about a bug is not the bug.
  assert.doesNotMatch(source, /^const TOKEN_BUDGET_PER_FILE\b/mu);
});
