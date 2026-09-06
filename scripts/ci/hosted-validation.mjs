#!/usr/bin/env node
/** Required hosted gate runner. Commands and selection contracts have one inventory. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [lane] = process.argv.slice(2);
const inventoryPath = 'scripts/ci/hosted-validation.inventory.json';
const inventoryText = readFileSync(inventoryPath, 'utf8');
const inventory = JSON.parse(inventoryText);
const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
const prHead = process.env.PR_HEAD_SHA || head;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Heavy validation requires a GitHub-hosted Actions runner');
}
if (![base, head, prHead].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
  throw new Error('BASE_SHA, HEAD_SHA and PR_HEAD_SHA must be immutable commit SHAs');
}
const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (checkout !== head) throw new Error('The checkout differs from the tested merge SHA');
if (!inventory.lanes.includes(lane)) throw new Error(`Unknown hosted lane: ${lane}`);
const gates = inventory.gates.filter((gate) => gate.lane === lane);
if (gates.length === 0) throw new Error('A required lane selected no gate commands');
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
  gates: [],
};
mkdirSync('artifacts/hosted-validation', { recursive: true });
let failed = false;
for (const gate of gates) {
  const command = gate.command.map((arg) => arg.replaceAll('{base}', base).replaceAll('{head}', head));
  const started = Date.now();
  process.stdout.write(`::group::${gate.id} (${gate.selection})\n`);
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, FORMAT_BASE_SHA: base, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  });
  process.stdout.write('::endgroup::\n');
  const success = result.status === 0 && !result.error;
  receipt.gates.push({ id: gate.id, command, selection: gate.selection, success, exit_code: result.status, elapsed_ms: Date.now() - started });
  writeFileSync(`artifacts/hosted-validation/${lane}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  if (!success) failed = true;
}
if (failed || receipt.gates.length !== gates.length) process.exit(1);
