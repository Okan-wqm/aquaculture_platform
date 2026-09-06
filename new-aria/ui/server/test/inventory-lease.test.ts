import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobTable } from '../src/actions.ts';
import { loadConfig } from '../src/config.ts';
import { acquireInstallationLock, installationStoragePaths } from '../src/installation-lock.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import { TOKEN_HOLDER_PRINCIPAL } from '../src/principal.ts';

test('a pending inventory cannot publish after the installation lease is closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legal-job-lease-'));
  const config = loadConfig({ ARIA_TOOLS_DIR: join(root, 'tools'), ARIA_UI_TOKEN: 'lease-fixture-token-0123456789' });
  const lease = acquireInstallationLock(installationStoragePaths(config));
  let finish: () => void = () => undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let published = false;
  const jobs = new JobTable(lease, async (_config, _caseId, _title, _signer, assertAuthority) => ({
    runKey: 'legal-lease-fixture',
    execute: async () => { await waiting; assertAuthority(); published = true; },
  }));
  try {
    const signer = loadOrCreateSigner(config.ledgerKeyFile);
    const job = await jobs.startLegalInventory(config, { caseId: 'case-001', title: null }, signer, () => {});
    lease.close();
    finish();
    await jobs.waitForIdle();
    assert.equal(published, false);
    assert.equal(jobs.get(job.jobId, TOKEN_HOLDER_PRINCIPAL).state, 'failed');
  } finally { finish(); lease.close(); rmSync(root, { recursive: true }); }
});
