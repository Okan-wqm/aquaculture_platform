#!/usr/bin/env node
/**
 * Lints scripts/ci/affected-target-policy.json against the ADR-0017 contract.
 *
 * Usage: node scripts/ci/affected-target-policy-lint.mjs [--policy <path>] [--today YYYY-MM-DD]
 * Exit 0 when sound, 1 with one line per violation otherwise.
 *
 * The same validation runs inside write-affected-target-report.mjs on every
 * CI run; this entry point exists so the invariant suite and a developer can
 * ask the question without computing an affected set.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  isoDate,
  loadFindingStates,
  validateAffectedTargetPolicy,
} from './affected-target-policy-lib.mjs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
let policyPath = resolve(repoRoot, 'scripts/ci/affected-target-policy.json');
let today = isoDate(new Date());

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--policy') policyPath = resolve(argv[++index]);
  else if (argv[index] === '--today') today = argv[++index];
  else {
    console.error(`Unknown argument: ${argv[index]}`);
    process.exit(2);
  }
}

const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const violations = validateAffectedTargetPolicy(policy, {
  today,
  findingStates: loadFindingStates(repoRoot),
});
if (violations.length > 0) {
  console.error(`affected-target-policy: ${violations.length} violation(s) in ${policyPath}`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(`affected-target-policy: ${policyPath} is sound (today ${today}).`);
