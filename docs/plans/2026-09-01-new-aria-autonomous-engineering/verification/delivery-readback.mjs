import {
  assertReadbackFresh,
  D0_DELIVERY_CONTEXT,
  d0ReadbackId,
  validateSignedReadback,
} from './lib/delivery-readback-contract.mjs';
import { canonicalJson } from './lib/canonical.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { resolveGitHubDeliveryFacts } from './lib/github-delivery-provider.mjs';
import { resolveGitHubFinalNote } from './lib/github-final-note.mjs';
import { loadVerifiedPayload } from './lib/verify-signature.mjs';

const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactPrincipal = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const admissionKeys = [
  'accepted',
  'admission_principal_id',
  'admission_public_key_sha256',
  'dossier_sha256',
  'producer_principal_id',
  'review_admission_sha256',
  'reviewed_base_sha',
  'reviewed_head_sha',
  'review_count',
  'reviewer_principal_ids',
  'reviewer_public_key_sha256s',
  'reviewer_authority_bundle_sha256',
  'target_operator_principal_id',
  'target_operator_public_key_sha256',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function validPrincipal(value) {
  return typeof value === 'string' && exactPrincipal.test(value);
}

function validDigest(value) {
  return typeof value === 'string' && exactDigest.test(value);
}

function validAdmissionPrincipals(admission) {
  const reviewers = admission.reviewer_principal_ids;
  return (
    validPrincipal(admission.admission_principal_id) &&
    validPrincipal(admission.producer_principal_id) &&
    validPrincipal(admission.target_operator_principal_id) &&
    Array.isArray(reviewers) &&
    reviewers.length === 14 &&
    reviewers.every(validPrincipal) &&
    new Set(reviewers).size === reviewers.length
  );
}

function validAdmissionKeys(admission) {
  const reviewers = admission.reviewer_public_key_sha256s;
  const allKeys = [
    admission.admission_public_key_sha256,
    admission.target_operator_public_key_sha256,
    ...(Array.isArray(reviewers) ? reviewers : []),
  ];
  return [
    validDigest(admission.admission_public_key_sha256),
    validDigest(admission.target_operator_public_key_sha256),
    Array.isArray(reviewers),
    reviewers?.length === 14,
    reviewers?.every(validDigest),
    new Set(allKeys).size === 16,
  ].every(Boolean);
}

function validAdmissionEvidence(admission) {
  return [
    exactKeys(admission, admissionKeys),
    admission?.accepted === true,
    validDigest(admission?.dossier_sha256),
    validDigest(admission?.review_admission_sha256),
    validDigest(admission?.reviewer_authority_bundle_sha256),
    exactSha.test(admission?.reviewed_base_sha ?? ''),
    exactSha.test(admission?.reviewed_head_sha ?? ''),
    admission?.review_count === 12,
    validAdmissionPrincipals(admission ?? {}),
    validAdmissionKeys(admission ?? {}),
  ].every(Boolean);
}

function admittedDossier(options, live, payload, signer) {
  const admission = admitReviewDossier(options);
  if (!validAdmissionEvidence(admission)) {
    throw new Error('review dossier admission result is invalid');
  }
  if (admission.reviewed_head_sha !== live.head_sha) {
    throw new Error('review dossier admission head contradicts GitHub provider facts');
  }
  if (admission.reviewed_base_sha !== live.base_sha) {
    throw new Error('review dossier admission base contradicts GitHub provider facts');
  }
  if (payload.producer_principal_id !== admission.producer_principal_id) {
    throw new Error('readback producer contradicts verified dossier producer');
  }
  const unavailable = new Set([
    admission.admission_principal_id,
    admission.producer_principal_id,
    admission.target_operator_principal_id,
    ...admission.reviewer_principal_ids,
  ]);
  if (unavailable.has(signer.principalId)) {
    throw new Error('delivery operator is not independent from verified dossier principals');
  }
  const unavailableKeys = new Set([
    admission.admission_public_key_sha256,
    admission.target_operator_public_key_sha256,
    ...admission.reviewer_public_key_sha256s,
  ]);
  if (!validDigest(signer.public_key_sha256) || unavailableKeys.has(signer.public_key_sha256)) {
    throw new Error('delivery operator public key is not independent from verified dossier keys');
  }
  return admission;
}

function finalNoteExpectation(live, admission) {
  return {
    program_id: D0_DELIVERY_CONTEXT.program_id,
    work_unit_id: D0_DELIVERY_CONTEXT.work_unit_id,
    successor_work_unit_id: D0_DELIVERY_CONTEXT.successor_work_unit_id,
    pull_request_number: D0_DELIVERY_CONTEXT.pull_request_number,
    readback_id: d0ReadbackId(live.head_sha),
    reviewed_head_sha: live.head_sha,
    review_dossier_sha256: admission.dossier_sha256,
    review_admission_sha256: admission.review_admission_sha256,
  };
}

async function resolvedFinalNote(live, admission, githubToken) {
  return resolveGitHubFinalNote({
    repositorySlug: D0_DELIVERY_CONTEXT.repository_slug,
    pullRequestNumber: D0_DELIVERY_CONTEXT.pull_request_number,
    mergedAt: live.pull_merged_at,
    expected: finalNoteExpectation(live, admission),
    githubToken,
  });
}

function evidenceFrom(live, admission, finalNote) {
  return {
    base_sha: live.base_sha,
    reviewed_head_sha: live.head_sha,
    final_note_sha256: finalNote.final_note_sha256,
    final_note_identity_sha256: finalNote.final_note_identity_sha256,
    review_dossier_sha256: admission.dossier_sha256,
    review_admission_sha256: admission.review_admission_sha256,
    pull_merged_at: live.pull_merged_at,
  };
}

function liveDeliveryFacts(githubToken) {
  return resolveGitHubDeliveryFacts({
    repositorySlug: D0_DELIVERY_CONTEXT.repository_slug,
    pullRequestNumber: D0_DELIVERY_CONTEXT.pull_request_number,
    baseRef: D0_DELIVERY_CONTEXT.base_ref,
    githubToken,
  });
}

function requireStableProviderFacts(before, after) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error('GitHub provider facts changed during verification');
  }
}

function requireStableFinalNote(before, after) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error('GitHub final note changed during verification');
  }
}

function compareProvider(payload, live) {
  const provider = payload.provider;
  const pairs = [
    [provider.repository_id, live.repository_id],
    [provider.repository_node_id, live.repository_node_id],
    [provider.pull_request_url, live.pull_request_url],
    [provider.base_ref, live.base_ref],
    [provider.enforce_admins, live.enforce_admins],
    [provider.strict_required_checks, live.strict_required_checks],
    [provider.required_checks_sha256, live.required_checks_sha256],
    [provider.ruleset_sha256, live.ruleset_sha256],
    [payload.base_sha, live.base_sha],
    [payload.reviewed_head_sha, live.head_sha],
    [payload.merge_commit_sha, live.merge_commit_sha],
    [payload.resulting_main_sha, live.main_sha],
  ];
  if (pairs.some(([declared, actual]) => declared !== actual)) {
    throw new Error('signed delivery readback contradicts current GitHub provider facts');
  }
  if (JSON.stringify(payload.merge_parent_shas) !== JSON.stringify(live.merge_parent_shas)) {
    throw new Error('signed merge parents contradict current GitHub provider facts');
  }
  const invalidation = payload.invalidation_facts;
  if (
    invalidation.main_sha !== live.main_sha ||
    invalidation.head_sha !== live.head_sha ||
    invalidation.required_checks_sha256 !== live.required_checks_sha256 ||
    invalidation.ruleset_sha256 !== live.ruleset_sha256
  ) {
    throw new Error('delivery readback invalidation facts are stale');
  }
}

export async function verifyDeliveryReadback(options) {
  const { payload, signer } = loadVerifiedPayload({
    repositoryRoot: options.repositoryRoot,
    authorityRoot: options.authorityRoot,
    envelopePath: options.envelopePath,
    trustRootPath: options.trustRootPath,
    trustRootSha256: options.trustRootSha256,
    expectedKind: 'new-aria-delivery-readback',
    expectedCapability: 'delivery-readback',
  });
  assertReadbackFresh(payload);
  const live = await liveDeliveryFacts(options.githubToken);
  const admission = admittedDossier(options.dossierAdmission, live, payload, signer);
  const initialFinalNote = await resolvedFinalNote(live, admission, options.githubToken);
  const finalLive = await liveDeliveryFacts(options.githubToken);
  requireStableProviderFacts(live, finalLive);
  const finalNote = await resolvedFinalNote(finalLive, admission, options.githubToken);
  requireStableFinalNote(initialFinalNote, finalNote);
  validateSignedReadback(payload, evidenceFrom(finalLive, admission, finalNote), signer);
  assertReadbackFresh(payload);
  compareProvider(payload, finalLive);
  return {
    accepted: true,
    readback_id: payload.readback_id,
    merge_commit_sha: payload.merge_commit_sha,
    resulting_main_sha: payload.resulting_main_sha,
  };
}
