import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTOMATION_REPOSITORY,
  AUTOMATION_REPOSITORY_ID,
} from '../../gates/lib/automation-publication-policy';
import {
  FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME,
  parseFindingRegistryRequestReceipt,
} from '../../gates/lib/finding-registry-request-receipt';

const repoRoot = resolve(__dirname, '..', '..', '..');
const tsNode = join(repoRoot, 'node_modules', '.bin', 'ts-node');
const writer = 'tools/scripts/automation/write-finding-registry-request-receipt.ts';

function environment(runnerTemp: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: AUTOMATION_REPOSITORY,
    GITHUB_REPOSITORY_ID: AUTOMATION_REPOSITORY_ID,
    GITHUB_WORKFLOW_REF: `${AUTOMATION_REPOSITORY}/.github/workflows/finding-registry-authority.yml@refs/heads/main`,
    GITHUB_SHA: '1'.repeat(40),
    GITHUB_RUN_ID: '91',
    GITHUB_RUN_ATTEMPT: '2',
    COMMAND_ID: 'finding-request:INC-1234',
    OPERATION: 'add',
    INPUT_SHA256: '2'.repeat(64),
  };
}

function run(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(tsNode, ['--project', 'tools/scripts/automation/tsconfig.json', writer], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

void describe('finding registry request receipt writer', () => {
  void it('creates one canonical receipt and refuses replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-registry-receipt-'));
    try {
      const first = run(environment(directory));
      assert.equal(first.status, 0, first.stderr);
      const receiptPath = join(directory, FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME);
      const receipt = parseFindingRegistryRequestReceipt(readFileSync(receiptPath));
      assert.equal(receipt.command_id, 'finding-request:INC-1234');
      assert.equal(receipt.workflow_run_id, 91);

      const replacement = run(environment(directory));
      assert.notEqual(replacement.status, 0);
      assert.match(replacement.stderr, /EEXIST/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  void it('fails before writing for a foreign repository identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-registry-receipt-'));
    try {
      const result = run({ ...environment(directory), GITHUB_REPOSITORY: 'foreign/repository' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /differs from automation authority/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
