#!/usr/bin/env node
/** Explicit auth release proof; never affected-selected, quarantined or restored from Nx cache. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateTestProof } from './test-proof-report.mjs';

const [lane] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Authentication proof requires a GitHub-hosted Actions runner');
}
const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
const prHead = process.env.PR_HEAD_SHA;
if (![base, head, prHead].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
  throw new Error('Immutable base/head identities required');
const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (checkout !== head) throw new Error('Proof checkout differs from candidate');
const inventoryText = readFileSync('scripts/ci/authentication-proof.inventory.json', 'utf8');
const inventory = JSON.parse(inventoryText);
if (!inventory.lanes.includes(lane)) throw new Error(`Unknown authentication proof lane: ${lane}`);
const checks = inventory.checks.filter((check) => check.lane === lane);
if (checks.length === 0) throw new Error('No release checks selected');
const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => /\.(spec|test)\.[cm]?[tj]sx?$/.test(file))
  .map((file) => resolve(file));
const receipt = {
  schema_version: 1,
  base_sha: base,
  pr_head_sha: prHead,
  tested_merge_sha: head,
  run_id: process.env.GITHUB_RUN_ID,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  runner_environment: process.env.RUNNER_ENVIRONMENT,
  inventory_sha256: createHash('sha256').update(inventoryText).digest('hex'),
  lane,
  checks: [],
};
mkdirSync('artifacts/authentication-proof', { recursive: true });
let failed = false;
for (const check of checks) {
  process.stdout.write(`::group::${check.id}\n`);
  const result = spawnSync(check.command[0], check.command.slice(1), {
    cwd: check.cwd,
    stdio: 'inherit',
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  });
  process.stdout.write('::endgroup::\n');
  const evidence = {
    id: check.id,
    command: check.command,
    success: result.status === 0 && !result.error,
    exit_code: result.status,
  };
  if (check.report) {
    try {
      const raw = readFileSync(check.report, 'utf8');
      const report = JSON.parse(raw);
      const testProof = evaluateTestProof(report, check.required_files || [], changed);
      const commandSucceeded = evidence.success;
      Object.assign(evidence, testProof);
      evidence.report_sha256 = createHash('sha256').update(raw).digest('hex');
      evidence.success = commandSucceeded && testProof.success;
    } catch (error) {
      evidence.success = false;
      evidence.report_error = error instanceof Error ? error.message : String(error);
    }
  }
  receipt.checks.push(evidence);
  writeFileSync(
    `artifacts/authentication-proof/${lane}-receipt.json`,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  if (!evidence.success) failed = true;
}
if (failed) process.exit(1);
