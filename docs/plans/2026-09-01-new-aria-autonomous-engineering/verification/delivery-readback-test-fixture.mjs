import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { D0_DELIVERY_CONTEXT } from './lib/delivery-readback-contract.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { createFixture as createDossierFixture } from './dossier-test-fixture.mjs';
import {
  githubDeliveryFixture,
  installGitHubFetch,
  mergeSha,
} from './delivery-github-test-fixture.mjs';

export { mergeSha };

function payload(fixture, admission, now) {
  const { expected } = fixture;
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-delivery-readback-v1',
    program_id: D0_DELIVERY_CONTEXT.program_id,
    work_unit_id: D0_DELIVERY_CONTEXT.work_unit_id,
    successor_work_unit_id: D0_DELIVERY_CONTEXT.successor_work_unit_id,
    readback_id: expected.readbackId,
    observation_sequence: 1,
    observation_id: 'd0-provider-observation-000001',
    repository_slug: D0_DELIVERY_CONTEXT.repository_slug,
    provider: {
      system: 'GITHUB_API',
      repository_id: 1132698735,
      repository_node_id: 'R_kgDOQ4Ocbw',
      pull_request_url: 'https://github.com/Okan-wqm/aquaculture_platform/pull/1393',
      base_ref: D0_DELIVERY_CONTEXT.base_ref,
      enforce_admins: true,
      strict_required_checks: true,
      required_checks_sha256: fixture.checksSha,
      ruleset_sha256: fixture.rulesetSha,
    },
    pull_request_number: D0_DELIVERY_CONTEXT.pull_request_number,
    merge_method: 'MERGE_COMMIT',
    base_sha: expected.reviewedBaseSha,
    reviewed_head_sha: expected.reviewedHeadSha,
    merge_commit_sha: mergeSha,
    merge_parent_shas: [expected.reviewedBaseSha, expected.reviewedHeadSha],
    resulting_main_sha: mergeSha,
    final_note_sha256: expected.finalNoteSha256,
    final_note_identity_sha256: expected.finalNoteIdentitySha256,
    review_dossier_sha256: expected.reviewDossierSha256,
    review_admission_sha256: expected.reviewAdmissionSha256,
    bypass_used: false,
    producer_principal_id: admission.producer_principal_id,
    operator_principal_id: 'delivery-operator',
    observed_at: new Date(now - 5_000).toISOString(),
    valid_until: new Date(now + 294_000).toISOString(),
    invalidation_facts: {
      main_sha: mergeSha,
      head_sha: expected.reviewedHeadSha,
      required_checks_sha256: fixture.checksSha,
      ruleset_sha256: fixture.rulesetSha,
    },
  };
}

function signedAuthority(dossier, value, principalId, signerOverride) {
  const root = join(dossier.ownerRoot, 'external', 'delivery');
  mkdirSync(root, { recursive: true });
  const keys = signerOverride
    ? {
        privateKey: signerOverride.privateKey,
        publicKey: createPublicKey(signerOverride.privateKey),
      }
    : generateKeyPairSync('ed25519');
  const envelope = {
    schema_version: '1.0.0',
    kind: 'new-aria-delivery-readback',
    algorithm: 'Ed25519',
    key_id: 'delivery-operator-key',
    payload: value,
    signature_base64: sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString(
      'base64',
    ),
  };
  const trustRoot = {
    schema_version: '1.0.0',
    kind: 'new-aria-external-trust-root',
    algorithm: 'Ed25519',
    key_id: 'delivery-operator-key',
    principal_id: principalId,
    capabilities: ['delivery-readback'],
    public_key_spki_base64: keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
  };
  const envelopePath = join(root, 'readback.json');
  const trustRootPath = join(root, 'trust-root.json');
  writeFileSync(envelopePath, `${JSON.stringify(envelope)}\n`);
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  return {
    repositoryRoot: dossier.options.repositoryRoot,
    authorityRoot: root,
    envelopePath,
    trustRootPath,
    trustRootSha256: sha256(readFileSync(trustRootPath)),
    dossierAdmission: dossier.options,
  };
}

async function runReadbackCase(dossier, admission, testCase) {
  const { mutator, run, principalId, signerOverride } = testCase;
  const now = Date.now();
  const github = githubDeliveryFixture(admission, now);
  const value = payload(github, admission, now);
  mutator(value, github);
  const authority = signedAuthority(dossier, value, principalId, signerOverride);
  const fetchState = installGitHubFetch(github);
  try {
    await run(authority, fetchState.calls, github);
  } finally {
    fetchState.restore();
  }
}

function runFreshReadbackCase(dossier, testCase) {
  dossier.refreshAuthority();
  const admission = admitReviewDossier(dossier.options);
  const signerOverride =
    typeof testCase.signerOverride === 'function'
      ? testCase.signerOverride(dossier)
      : testCase.signerOverride;
  return runReadbackCase(dossier, admission, { ...testCase, signerOverride });
}

export function createReadbackSuite() {
  const dossier = createDossierFixture();
  return {
    withReadbackCase: (mutator, run, principalId = 'delivery-operator', signerOverride) =>
      runFreshReadbackCase(dossier, { mutator, run, principalId, signerOverride }),
    reviewerSigner: (current) => current.authority.reviewerSigners[0],
    cleanup: dossier.cleanup,
  };
}

export function cliArguments(authority) {
  const dossier = authority.dossierAdmission;
  return [
    '--repository-root',
    authority.repositoryRoot,
    '--readback-authority-root',
    authority.authorityRoot,
    '--readback-context-envelope',
    authority.envelopePath,
    '--readback-trust-root',
    authority.trustRootPath,
    '--readback-trust-root-sha256',
    authority.trustRootSha256,
    '--review-artifact-root',
    dossier.artifactRoot,
    '--review-dossier',
    dossier.dossierPath,
    '--review-context-envelope',
    dossier.contextEnvelopePath,
    '--review-trust-root',
    dossier.trustRootPath,
    '--review-authority-root',
    dossier.authorityRoot,
    '--review-trust-root-sha256',
    dossier.trustRootSha256,
    '--reviewer-authority-root',
    dossier.reviewerAuthorityRoot,
    '--reviewer-authority-bundle',
    dossier.reviewerAuthorityBundlePath,
    '--reviewer-authority-bundle-sha256',
    dossier.reviewerAuthorityBundleSha256,
    '--target-authority-root',
    dossier.targetAuthorityRoot,
    '--target-context-envelope',
    dossier.targetContextEnvelopePath,
    '--target-trust-root',
    dossier.targetTrustRootPath,
    '--target-trust-root-sha256',
    dossier.targetTrustRootSha256,
  ];
}
