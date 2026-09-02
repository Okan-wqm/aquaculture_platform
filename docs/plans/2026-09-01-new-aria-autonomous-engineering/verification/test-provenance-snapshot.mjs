#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTargetFixture } from './dossier-target-test-fixture.mjs';
import { canonicalJson } from './lib/canonical.mjs';
import { parseReviewPolicy } from './lib/verify-dossier.mjs';
import {
  loadVerifiedProvenance,
  verifyProvenance,
  verifyWorktreeProvenance,
} from './lib/verify-provenance.mjs';
import { withProvenanceSnapshot } from './lib/provenance-snapshot.mjs';
import { verifyAuthorizedTarget } from './lib/verify-target.mjs';

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-provenance-snapshot-'));
try {
  const fixture = createTargetFixture(ownerRoot, {});
  const authority = {
    authorityRoot: fixture.targetOptions.targetAuthorityRoot,
    contextPath: fixture.targetOptions.targetContextEnvelopePath,
    trustRootPath: fixture.targetOptions.targetTrustRootPath,
    trustRootSha256: fixture.targetOptions.targetTrustRootSha256,
  };
  const result = verifyAuthorizedTarget(fixture.repositoryRoot, authority);
  assert.deepEqual(result.errors, []);
  const planRoot = join(
    fixture.repositoryRoot,
    'docs/plans/2026-09-01-new-aria-autonomous-engineering',
  );
  assert.match(verifyProvenance(planRoot)[0].message, /snapshot required/u);
  writeFileSync(join(planRoot, 'verification/verifier-inputs.jsonl'), 'mutable forgery\n');
  const snapshot = loadVerifiedProvenance(planRoot, {
    repositoryRoot: fixture.repositoryRoot,
    revision: result.facts.head_sha,
    gitTool: result.facts.git_tool,
  });
  assert(snapshot.provenanceBytes.equals(fixture.provenanceBytes));
  const policyPath = 'verification/review-policy.json';
  const committedPolicy = Buffer.from(snapshot.files.get(policyPath));
  writeFileSync(join(planRoot, policyPath), Buffer.from([0x7b, 0x80, 0x7d]));
  assert.deepEqual(snapshot.files.get(policyPath), committedPolicy, 'policy snapshot was reread');
  assert.doesNotThrow(() => parseReviewPolicy(snapshot.files.get(policyPath)));
  withProvenanceSnapshot(snapshot.files, ({ planRoot: immutablePlanRoot }) => {
    assert.doesNotThrow(() => parseReviewPolicy(readFileSync(join(immutablePlanRoot, policyPath))));
  });
  writeFileSync(join(planRoot, 'verification/verifier-inputs.jsonl'), 'second forgery\n');
  assert(snapshot.provenanceBytes.equals(fixture.provenanceBytes), 'snapshot bytes were reread');

  const manifestPath = join(planRoot, 'verification/verifier-inputs.jsonl');
  writeFileSync(join(planRoot, policyPath), committedPolicy);
  writeFileSync(manifestPath, fixture.provenanceBytes);
  assert.deepEqual(verifyWorktreeProvenance(planRoot), []);
  const [metadata, ...records] = fixture.provenanceBytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map(JSON.parse);
  metadata.runtime.dependencies.pop();
  writeFileSync(
    manifestPath,
    `${[metadata, ...records].map((record) => canonicalJson(record)).join('\n')}\n`,
  );
  assert(
    verifyWorktreeProvenance(planRoot).some(({ code }) => code === 'VERIFIER_RUNTIME'),
    'provenance accepted an omitted runtime dependency',
  );
  metadata.runtime.dependencies = snapshot.metadata.runtime.dependencies;
  metadata.runtime.package_lock_sha256 = '0'.repeat(64);
  writeFileSync(
    manifestPath,
    `${[metadata, ...records].map((record) => canonicalJson(record)).join('\n')}\n`,
  );
  assert(
    verifyWorktreeProvenance(planRoot).some(
      ({ code, message }) => code === 'VERIFIER_RUNTIME' && /package-lock/u.test(message),
    ),
    'provenance accepted a package-lock digest mismatch',
  );
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS provenance-snapshot source=commit reread=none\n');
