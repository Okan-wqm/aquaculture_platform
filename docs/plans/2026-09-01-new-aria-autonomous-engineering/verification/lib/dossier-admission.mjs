import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';
import { createDossierAdmissionResult } from './dossier-admission-result.mjs';
import { resolveDossierTarget, verifyDossierTargetArtifacts } from './dossier-target.mjs';
import { loadReviewerAuthority } from './review-authority.mjs';
import { verifySignedReviews } from './review-evidence.mjs';
import {
  verifyDossierDecision,
  verifySignedConflict,
  verifySignedOracle,
} from './review-oracle.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { loadReviewPolicy, validateDossierStructure } from './verify-dossier.mjs';
import { loadVerifiedPayload } from './verify-signature.mjs';

const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
const contextKeys = [
  'schema_version',
  'contract_id',
  'dossier_sha256',
  'operator_principal_id',
  'reviewed_target',
  'reviewer_authority_bundle_sha256',
  'producer_artifact',
  'authority_artifact',
  'observed_at',
  'valid_until',
  'report_artifacts',
  'conflict_artifact',
  'oracle_artifact',
  'invalidation_facts',
];
const artifactKeys = ['artifact_uri', 'sha256'];
const reportKeys = ['role', 'report_uri', 'sha256'];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function digest(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function contextClock(context, policy) {
  const observed = Date.parse(context.observed_at);
  const validUntil = Date.parse(context.valid_until);
  const now = Date.now();
  return (
    Number.isFinite(observed) &&
    observed <= now &&
    now < validUntil &&
    validUntil - observed <= policy.max_freshness_seconds * 1000
  );
}

function expectedInvalidationFacts(resources) {
  const { dossier, policy, reports, authorityDigest } = resources;
  return {
    head: dossier.reviewed_target.head_sha,
    'target-authority': dossier.reviewed_target.authority_bundle_sha256,
    'reviewer-authority': authorityDigest,
    'verifier-provenance': dossier.reviewed_target.verifier_inputs_sha256,
    'producer-artifact': resources.context.producer_artifact.sha256,
    'authority-artifact': resources.context.authority_artifact.sha256,
    'review-policy': digest(policy),
    dossier: digest(dossier),
    reports: digest(reports),
    oracle: digest(dossier.oracle),
    dissent: digest(dossier.dissent),
    appellate: digest(dossier.appellate),
    conflicts: digest(dossier.conflict_graph),
  };
}

function validateContextSchema(context, policy) {
  if (
    !exactKeys(context, contextKeys) ||
    !exactKeys(policy, [
      'contract_id',
      'envelope_kind',
      'required_invalidation_keys',
      'max_freshness_seconds',
    ]) ||
    !exactKeys(context.producer_artifact, artifactKeys) ||
    !exactKeys(context.authority_artifact, artifactKeys) ||
    !exactKeys(context.conflict_artifact, artifactKeys) ||
    !exactKeys(context.oracle_artifact, artifactKeys) ||
    !Array.isArray(context.report_artifacts) ||
    context.report_artifacts.some((artifact) => !exactKeys(artifact, reportKeys))
  ) {
    throw new Error('signed dossier context schema is closed and required');
  }
}

function expectedDecisionArtifacts(dossier) {
  return {
    conflict: {
      artifact_uri: dossier.conflict_graph.envelope_uri,
      sha256: dossier.conflict_graph.envelope_sha256,
    },
    oracle: {
      artifact_uri: dossier.oracle.envelope_uri,
      sha256: dossier.oracle.envelope_sha256,
    },
  };
}

function verifyContext(resources) {
  const { context, dossier, policy, signer, reports, authorityDigest } = resources;
  const contextPolicy = policy.admission_context;
  validateContextSchema(context, contextPolicy);
  if (
    context.operator_principal_id !== signer.principalId ||
    dossier.admission.operator_principal_id !== signer.principalId
  ) {
    throw new Error('signed dossier context operator principal does not match its signer');
  }
  if (!contextClock(context, contextPolicy)) {
    throw new Error('signed dossier context clock is expired or outside its freshness window');
  }
  const artifacts = expectedDecisionArtifacts(dossier);
  const accepted = [
    context.schema_version === '1.0.0',
    context.contract_id === contextPolicy.contract_id,
    context.dossier_sha256 === digest(dossier),
    equal(context.reviewed_target, dossier.reviewed_target),
    context.reviewer_authority_bundle_sha256 === authorityDigest,
    context.observed_at === dossier.freshness.observed_at,
    context.valid_until === dossier.freshness.valid_until,
    equal(context.report_artifacts, reports),
    equal(context.conflict_artifact, artifacts.conflict),
    equal(context.oracle_artifact, artifacts.oracle),
    equal(context.invalidation_facts, expectedInvalidationFacts(resources)),
    equal(dossier.freshness.invalidation_keys, contextPolicy.required_invalidation_keys),
  ].every(Boolean);
  if (!accepted) throw new Error('signed dossier context contradicts resolved admission facts');
}

function admissionContext(repositoryRoot, options, policy) {
  const before = readFileSync(options.contextEnvelopePath);
  const verified = loadVerifiedPayload({
    repositoryRoot,
    authorityRoot: options.authorityRoot,
    envelopePath: options.contextEnvelopePath,
    trustRootPath: options.trustRootPath,
    trustRootSha256: options.trustRootSha256,
    expectedKind: policy.admission_context.envelope_kind,
    expectedCapability: 'review-dossier-admission',
  });
  const after = readFileSync(options.contextEnvelopePath);
  if (!before.equals(after)) throw new Error('signed dossier context changed during admission');
  return { ...verified, envelopeSha256: sha256(after) };
}

function authorityExpectation(dossier, resolved, signer, policy) {
  return {
    roles: policy.roles,
    reviewedTarget: resolved.reviewedTarget,
    producer: {
      principal_id: dossier.producer.principal_id,
      session_id: dossier.producer.session_id,
    },
    admissionPrincipal: signer.principalId,
    maxFreshnessSeconds: policy.admission_context.max_freshness_seconds,
  };
}

function verifiedReviewResources(options, dossier, policy, resolved, admission) {
  const reviewer = loadReviewerAuthority(
    options,
    authorityExpectation(dossier, resolved, admission.signer, policy),
  );
  verifyDossierTargetArtifacts(options.artifactRoot, dossier, admission.payload, resolved);
  const targetDigest = digest(resolved.reviewedTarget);
  const reviewResources = {
    artifactRoot: options.artifactRoot,
    authorityDigest: reviewer.sha256,
    targetDigest,
  };
  const reviews = verifySignedReviews(dossier, reviewer.bundle, reviewResources);
  return { reviewer, targetDigest, reviews };
}

export function admitReviewDossier(options) {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const policy = loadReviewPolicy(join(repositoryRoot, planPath));
  const dossierBytes = readSecureArtifact(options.artifactRoot, options.dossierPath);
  const dossier = parseStrictJson(dossierBytes.toString('utf8'));
  const errors = validateDossierStructure(dossier, policy);
  if (errors.length > 0) throw new Error(`dossier structure rejected: ${errors[0].message}`);
  const admission = admissionContext(repositoryRoot, options, policy);
  const resolved = resolveDossierTarget({ ...options, repositoryRoot });
  const verified = verifiedReviewResources(options, dossier, policy, resolved, admission);
  const oracleResources = {
    artifactRoot: options.artifactRoot,
    authorityDigest: verified.reviewer.sha256,
    targetDigest: verified.targetDigest,
    reviewedTarget: resolved.reviewedTarget,
    policyDigest: digest(policy),
    reportPayloads: verified.reviews.reportPayloads,
  };
  const conflict = verifySignedConflict(dossier, verified.reviewer.bundle, oracleResources);
  verifySignedOracle(dossier, verified.reviewer.bundle, oracleResources, conflict);
  verifyDossierDecision(dossier, verified.reviews.reportPayloads);
  verifyContext({
    context: admission.payload,
    dossier,
    policy,
    signer: admission.signer,
    reports: verified.reviews.reportArtifacts,
    authorityDigest: verified.reviewer.sha256,
  });
  return createDossierAdmissionResult({
    dossier,
    admission,
    resolved,
    verified,
    dossierSha256: digest(dossier),
  });
}
