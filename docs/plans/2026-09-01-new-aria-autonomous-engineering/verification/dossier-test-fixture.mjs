import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { loadReviewPolicy } from './lib/verify-dossier.mjs';
import {
  writeAdmissionAuthority,
  writeArtifact,
  writeReviewerAuthority,
} from './dossier-crypto-test-fixture.mjs';
import { createReviewDossier } from './dossier-review-test-fixture.mjs';
import { createTargetFixture } from './dossier-target-test-fixture.mjs';
import { planRoot } from './test-support.mjs';

export const policy = loadReviewPolicy(planRoot);
const admissionPrincipal = 'admission-operator';

export function digest(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function reportArtifacts(dossier) {
  return dossier.reviews.map((review) => ({
    role: review.role,
    report_uri: review.report_uri,
    sha256: review.report_sha256,
  }));
}

function invalidationFacts(dossier, artifacts, authority) {
  return {
    head: dossier.reviewed_target.head_sha,
    'target-authority': dossier.reviewed_target.authority_bundle_sha256,
    'reviewer-authority': authority.sha256,
    'verifier-provenance': dossier.reviewed_target.verifier_inputs_sha256,
    'producer-artifact': artifacts.producer.sha256,
    'authority-artifact': artifacts.targetAuthority.sha256,
    'review-policy': digest(policy),
    dossier: digest(dossier),
    reports: digest(reportArtifacts(dossier)),
    oracle: digest(dossier.oracle),
    dissent: digest(dossier.dissent),
    appellate: digest(dossier.appellate),
    conflicts: digest(dossier.conflict_graph),
  };
}

function buildContext(dossier, artifacts, authority) {
  const context = {
    schema_version: '1.0.0',
    contract_id: policy.admission_context.contract_id,
    dossier_sha256: digest(dossier),
    operator_principal_id: admissionPrincipal,
    reviewed_target: dossier.reviewed_target,
    reviewer_authority_bundle_sha256: authority.sha256,
    producer_artifact: artifacts.producer,
    authority_artifact: artifacts.targetAuthority,
    observed_at: dossier.freshness.observed_at,
    valid_until: dossier.freshness.valid_until,
    report_artifacts: reportArtifacts(dossier),
    conflict_artifact: artifacts.conflict,
    oracle_artifact: artifacts.oracle,
    invalidation_facts: {},
  };
  context.invalidation_facts = invalidationFacts(dossier, artifacts, authority);
  return context;
}

function createArtifacts(artifactRoot, target) {
  return {
    producer: writeArtifact(artifactRoot, 'program-bundle.json', target.provenanceBytes),
    targetAuthority: writeArtifact(
      artifactRoot,
      'authority/target-context.json',
      target.targetEnvelopeBytes,
    ),
  };
}

function admissionOptions(target, artifactRoot, authority, admission) {
  return {
    repositoryRoot: target.repositoryRoot,
    artifactRoot,
    dossierPath: 'dossier.json',
    contextEnvelopePath: admission.envelopePath,
    trustRootPath: admission.trustRootPath,
    authorityRoot: admission.root,
    trustRootSha256: sha256(readFileSync(admission.trustRootPath)),
    reviewerAuthorityRoot: authority.root,
    reviewerAuthorityBundlePath: authority.path,
    reviewerAuthorityBundleSha256: authority.sha256,
    ...target.targetOptions,
  };
}

function materializeDossier(target, artifactRoot, now = Date.now()) {
  const freshness = {
    observedAt: new Date(now - 1_000).toISOString(),
    validUntil: new Date(now + 268_000).toISOString(),
  };
  const producerIdentity = {
    principal_id: 'producer-principal',
    session_id: 'producer-session',
  };
  const authority = writeReviewerAuthority(target.externalRoot, {
    roles: policy.roles,
    reviewedTarget: target.reviewedTarget,
    producer: producerIdentity,
    admissionPrincipal,
    observedAt: new Date(now - 30_000).toISOString(),
    validUntil: freshness.validUntil,
  });
  const artifacts = createArtifacts(artifactRoot, target);
  const producer = { ...producerIdentity, artifact_uri: artifacts.producer.artifact_uri };
  const review = createReviewDossier({
    artifactRoot,
    repositoryRoot: target.repositoryRoot,
    gitTool: target.gitTool,
    target: target.reviewedTarget,
    authority,
    producer,
    policy,
    freshness,
  });
  const { dossier } = review;
  writeFileSync(join(artifactRoot, 'dossier.json'), `${JSON.stringify(dossier)}\n`);
  artifacts.conflict = review.conflict.artifact;
  artifacts.oracle = review.oracle.artifact;
  const context = buildContext(dossier, artifacts, authority);
  const admission = writeAdmissionAuthority(target.externalRoot, context);
  return {
    options: admissionOptions(target, artifactRoot, authority, admission),
    dossier,
    context,
    resign: admission.resign,
    authority,
  };
}

export function createFixture() {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-dossier-admission-'));
  const target = createTargetFixture(ownerRoot, policy);
  const artifactRoot = join(ownerRoot, 'artifacts');
  mkdirSync(artifactRoot);
  let current = materializeDossier(target, artifactRoot);
  const cleanup = () => rmSync(ownerRoot, { recursive: true, force: true });
  const fixture = {
    ownerRoot,
    get options() {
      return current.options;
    },
    get dossier() {
      return current.dossier;
    },
    get context() {
      return current.context;
    },
    get resign() {
      return current.resign;
    },
    get authority() {
      return current.authority;
    },
    refreshAuthority() {
      target.refreshAuthority();
      current = materializeDossier(target, artifactRoot);
      return fixture;
    },
    cleanup,
  };
  return fixture;
}

export function withFixture(run) {
  const fixture = createFixture();
  try {
    const result = run(fixture);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(fixture.cleanup);
    }
    fixture.cleanup();
    return result;
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}
