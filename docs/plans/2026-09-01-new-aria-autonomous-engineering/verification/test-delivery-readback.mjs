#!/usr/bin/env node

import assert from 'node:assert/strict';
import { verifyDeliveryReadback } from './delivery-readback.mjs';
import { cliArguments, createReadbackSuite, mergeSha } from './delivery-readback-test-fixture.mjs';
import { argumentsFrom, runDeliveryReadbackCli } from './verify-delivery-readback.mjs';

const suite = createReadbackSuite();
const { withReadbackCase } = suite;
process.once('exit', suite.cleanup);

const resourceArguments = [
  '--repository-root',
  '/repo',
  '--readback-authority-root',
  '/readback',
  '--readback-context-envelope',
  '/readback/context.json',
  '--readback-trust-root',
  '/readback/trust.json',
  '--readback-trust-root-sha256',
  'a'.repeat(64),
  '--review-artifact-root',
  '/review-artifacts',
  '--review-dossier',
  'dossier.json',
  '--review-context-envelope',
  '/review/context.json',
  '--review-trust-root',
  '/review/trust.json',
  '--review-authority-root',
  '/review',
  '--review-trust-root-sha256',
  'b'.repeat(64),
  '--reviewer-authority-root',
  '/reviewer',
  '--reviewer-authority-bundle',
  '/reviewer/bundle.json',
  '--reviewer-authority-bundle-sha256',
  'c'.repeat(64),
  '--target-authority-root',
  '/target',
  '--target-context-envelope',
  '/target/context.json',
  '--target-trust-root',
  '/target/trust.json',
  '--target-trust-root-sha256',
  'd'.repeat(64),
];

const parsed = argumentsFrom(resourceArguments);
assert.equal(parsed.repositoryRoot, '/repo');
assert.equal(parsed.authorityRoot, '/readback');
assert.equal(parsed.dossierAdmission.reviewerAuthorityBundlePath, '/reviewer/bundle.json');
assert.equal(parsed.dossierAdmission.targetTrustRootSha256, 'd'.repeat(64));
assert.throws(
  () => argumentsFrom([...resourceArguments, '--program-id', 'forged-program']),
  /option|pairs/u,
  'caller-controlled expected identity remained accepted',
);

await withReadbackCase(
  () => {},
  async (authority, calls, github) => {
    assert.deepEqual(await verifyDeliveryReadback(authority), {
      accepted: true,
      readback_id: github.expected.readbackId,
      merge_commit_sha: mergeSha,
      resulting_main_sha: mergeSha,
    });
    assert.equal(calls.length, 26, 'provider facts must bracket both stable final-note snapshots');
  },
);

const actualNow = Date.now;
const agedNow = actualNow() + 901_000;
Date.now = () => agedNow;
try {
  await withReadbackCase(
    () => {},
    async (authority) => {
      assert.equal(
        (await verifyDeliveryReadback(authority)).accepted,
        true,
        'fresh same-head authorities were not issued after an aged suite clock',
      );
    },
  );
} finally {
  Date.now = actualNow;
}

function setBoundedObservation(value, observedAt) {
  value.observed_at = observedAt;
  value.valid_until = new Date(Date.parse(observedAt) + 299_000).toISOString();
}

for (const [name, mutate, pattern, signer] of [
  ['program replay', (value) => (value.program_id = 'other-program'), /program/u],
  ['cross-sprint replay', (value) => (value.successor_work_unit_id = 'S02'), /successor/u],
  ['readback replay', (value) => (value.readback_id = 'other-readback'), /readback/u],
  ['note substitution', (value) => (value.final_note_sha256 = '6'.repeat(64)), /final note/u],
  [
    'note identity substitution',
    (value) => (value.final_note_identity_sha256 = '6'.repeat(64)),
    /final note identity/u,
  ],
  ['dossier substitution', (value) => (value.review_dossier_sha256 = '6'.repeat(64)), /dossier/u],
  [
    'admission substitution',
    (value) => (value.review_admission_sha256 = '6'.repeat(64)),
    /admission/u,
  ],
  [
    'pre-merge observation',
    (value, github) =>
      setBoundedObservation(value, new Date(Date.parse(github.mergedAt) - 1).toISOString()),
    /strictly after/u,
  ],
  [
    'merge-time observation',
    (value, github) => setBoundedObservation(value, github.mergedAt),
    /strictly after/u,
  ],
  [
    'ambiguous same-second observation',
    (value, github) =>
      setBoundedObservation(value, new Date(Date.parse(github.mergedAt) + 500).toISOString()),
    /strictly after/u,
  ],
  [
    'producer substitution',
    (value) => (value.producer_principal_id = 'forged-producer'),
    /dossier producer/u,
  ],
  [
    'coordinated reviewed-base substitution',
    (value, github) => {
      const forgedBase = '8'.repeat(40);
      value.base_sha = forgedBase;
      value.merge_parent_shas[0] = forgedBase;
      github.bodies.pull.base.sha = forgedBase;
      github.bodies.commit.parents[0].sha = forgedBase;
    },
    /dossier admission base/u,
  ],
  ['non-canonical UTC', (value) => (value.observed_at = '2026-09-02T10:00:00Z'), /UTC/u],
  ['zero sequence', (value) => (value.observation_sequence = 0), /sequence/u],
  [
    'check invalidation drift',
    (value) => (value.invalidation_facts.required_checks_sha256 = '6'.repeat(64)),
    /invalidation/u,
  ],
  ['bypass claim', (value) => (value.bypass_used = true), /bypass/u],
  ['signer mismatch', () => {}, /operator signer/u, 'different-valid-signer'],
]) {
  await withReadbackCase(
    mutate,
    async (authority) => {
      await assert.rejects(verifyDeliveryReadback(authority), pattern, `${name} accepted`);
    },
    signer,
  );
}

for (const principal of [
  'admission-operator',
  'producer-principal',
  'target-operator',
  'integrity-principal-0',
  'oracle-principal-oracle',
  'conflict-principal-conflict',
]) {
  await withReadbackCase(
    () => {},
    async (authority) => {
      await assert.rejects(
        verifyDeliveryReadback(authority),
        /not independent/u,
        `${principal} was accepted as delivery operator`,
      );
    },
    principal,
  );
}

await withReadbackCase(
  () => {},
  async (authority) => {
    await assert.rejects(
      verifyDeliveryReadback(authority),
      /public key.*independent/u,
      'reviewer Ed25519 key was accepted under a new delivery principal and key ID',
    );
  },
  'aliased-delivery-principal',
  suite.reviewerSigner,
);

await withReadbackCase(
  () => {},
  async (authority) => {
    assert.equal(
      (await runDeliveryReadbackCli(cliArguments(authority), { GITHUB_TOKEN: 'test-token' }))
        .accepted,
      true,
    );
  },
);

suite.cleanup();
process.removeListener('exit', suite.cleanup);
process.stdout.write(
  'PASS delivery-readback online=stable-snapshots freshness=renewed mutants=25 cli=bound\n',
);
