#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluatePlaywrightProof } from './test-proof-report.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.HOSTED_E2E_ISOLATED !== 'true') {
  throw new Error('Browser proof requires the isolated hosted E2E stack');
}
const head = process.env.HEAD_SHA;
if (![head, process.env.BASE_SHA, process.env.PR_HEAD_SHA].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head) throw new Error('E2E candidate identity mismatch');
const lanes = [
  { name: 'security', config: 'playwright.config.ts', project: 'security', files: [
    'csrf.spec.ts', 'token-lifecycle.spec.ts', 'mfa-login.spec.ts', 'header-spoofing.spec.ts',
    'graphql-limits.spec.ts', 'rate-limiting.spec.ts', 'rbac-escalation.spec.ts', 'tenant-isolation.spec.ts'] },
  { name: 'mobile', config: 'playwright.aquamobil.config.ts', project: 'aquamobil-mobile', files: [
    'login.spec.ts', 'alerts-ack.spec.ts', 'messaging-smoke.spec.ts', 'ai-action-confirm.spec.ts',
    'record-forms.spec.ts', 'offline-sync-roundtrip.spec.ts'] },
];
mkdirSync('artifacts/hosted-e2e', { recursive: true });
const imageReceipt = readFileSync('artifacts/hosted-e2e/images.json');
const receipt = { base_sha: process.env.BASE_SHA, pr_head_sha: process.env.PR_HEAD_SHA, tested_merge_sha: head,
  run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  runner_environment: process.env.RUNNER_ENVIRONMENT,
  images_receipt_sha256: createHash('sha256').update(imageReceipt).digest('hex'), suites: [] };
let failed = false;
for (const lane of lanes) {
  const actualFiles = readdirSync(`e2e/tests/${lane.name}`).filter((file) => file.endsWith('.spec.ts')).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...lane.files].sort())) throw new Error(`E2E inventory differs from ${lane.name} source suites`);
  for (const file of lane.files) {
    const reset = spawnSync('node', ['scripts/ci/hosted-e2e-stack.mjs', 'reset-rate-limits'], { stdio: 'inherit' });
    if (reset.status !== 0 || reset.error) throw new Error('Isolated suite counter reset failed');
    const reportPath = resolve(`artifacts/hosted-e2e/${lane.name}-${file}.json`);
    const args = ['node_modules/@playwright/test/cli.js', 'test', `tests/${lane.name}/${file}`,
      '--config', lane.config, '--project', lane.project, '--retries=0', '--reporter=json,github'];
    const result = spawnSync('node', args, { cwd: 'e2e', stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } });
    const evidence = { lane: lane.name, file, success: result.status === 0 && !result.error, exit_code: result.status };
    try {
      const report = readFileSync(reportPath, 'utf8');
      const evaluated = evaluatePlaywrightProof(JSON.parse(report), [file]);
      const commandSucceeded = evidence.success;
      Object.assign(evidence, evaluated);
      evidence.success = commandSucceeded && evaluated.success;
      evidence.report_sha256 = createHash('sha256').update(report).digest('hex');
    } catch (error) {
      evidence.success = false;
      evidence.report_error = error instanceof Error ? error.message : String(error);
    }
    receipt.suites.push(evidence);
    writeFileSync('artifacts/hosted-e2e/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
    if (!evidence.success) failed = true;
  }
}

if (failed) process.exit(1);
