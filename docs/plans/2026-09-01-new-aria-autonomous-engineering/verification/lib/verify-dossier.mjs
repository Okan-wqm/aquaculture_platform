import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';
import { nestedKeys, reviewKeys, targetKeys } from './dossier-schema.mjs';
const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
function add(errors, message) {
  errors.push({ code: 'REVIEW_DOSSIER', message });
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && equal(Object.keys(value).sort(), [...keys].sort());
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function unique(values) {
  return values.every(nonEmptyString) && new Set(values).size === values.length;
}

function targetDigest(target) {
  return sha256(Buffer.from(canonicalJson(target), 'utf8'));
}

export function loadReviewPolicy(planRoot) {
  return parseStrictJson(readFileSync(join(planRoot, 'verification/review-policy.json'), 'utf8'));
}

function verifyTarget(errors, target) {
  if (!exactKeys(target, targetKeys)) {
    add(errors, 'reviewed_target: schema open or drifted');
    return;
  }
  for (const field of ['base_sha', 'base_tree', 'head_sha', 'head_tree']) {
    if (!sha40.test(target[field])) add(errors, `reviewed_target: ${field} is not exact SHA`);
  }
  for (const field of targetKeys.slice(5, 11)) {
    if (!sha64.test(target[field])) add(errors, `reviewed_target: ${field} is not exact SHA-256`);
  }
  if (
    !nonEmptyString(target.reviewed_ref) ||
    !nonEmptyString(target.target_operator_principal_id)
  ) {
    add(errors, 'reviewed_target: ref and target operator are required');
  }
}

function reviewBindingMatches(review, target) {
  return (
    isRecord(target) &&
    review.reviewed_head_sha === target.head_sha &&
    review.authority_bundle_sha256 === target.authority_bundle_sha256 &&
    review.reviewed_target_sha256 === targetDigest(target) &&
    sha64.test(review.reviewer_authority_bundle_sha256) &&
    review.verdict === 'ACCEPTED'
  );
}

function verifyReview(errors, dossier, review, index) {
  const label = nonEmptyString(review?.role) ? review.role : `review ${index}`;
  if (!exactKeys(review, reviewKeys)) {
    add(errors, `${label}: review schema open or drifted`);
    return;
  }
  for (const field of ['principal_id', 'session_id', 'report_uri']) {
    if (!nonEmptyString(review[field])) add(errors, `${label}: ${field} must be a string`);
  }
  if (!sha64.test(review.report_sha256)) add(errors, `${label}: report digest mismatch`);
  if (!equal(review.capabilities, [review.role])) add(errors, `${label}: capability mismatch`);
  if (!reviewBindingMatches(review, dossier.reviewed_target)) {
    add(errors, `${label}: signed target, reviewer authority, or verdict mismatch`);
  }
}

function verifyReviews(errors, dossier, policy) {
  if (!Array.isArray(dossier.reviews) || dossier.reviews.length !== policy.roles.length) {
    add(errors, 'exact review role count mismatch');
    return;
  }
  dossier.reviews.forEach((review, index) => verifyReview(errors, dossier, review, index));
  if (
    !equal(
      dossier.reviews.map((review) => review.role),
      policy.roles,
    )
  ) {
    add(errors, 'role roster drift');
  }
  for (const field of ['principal_id', 'session_id', 'report_uri', 'report_sha256']) {
    if (!unique(dossier.reviews.map((review) => review[field]))) add(errors, `${field} reuse`);
  }
  const authorities = dossier.reviews.map((review) => review.reviewer_authority_bundle_sha256);
  if (new Set(authorities).size !== 1) add(errors, 'reviewer authority bundle drift');
}

function verifyNestedSchemas(errors, dossier) {
  for (const [field, keys] of Object.entries(nestedKeys)) {
    if (!exactKeys(dossier[field], keys)) add(errors, `${field}: schema open or drifted`);
  }
  for (const field of ['principal_id', 'session_id', 'artifact_uri']) {
    if (!nonEmptyString(dossier.producer?.[field])) add(errors, `producer: ${field} is required`);
  }
}

function verifyArtifactRecord(errors, record, label) {
  for (const field of ['principal_id', 'session_id', 'envelope_uri']) {
    if (!nonEmptyString(record?.[field])) add(errors, `${label}: ${field} is required`);
  }
  if (!sha64.test(record?.envelope_sha256 ?? '')) add(errors, `${label}: digest mismatch`);
}

function identityValues(dossier) {
  return [
    dossier.producer?.principal_id,
    dossier.reviewed_target?.target_operator_principal_id,
    dossier.admission?.operator_principal_id,
    ...(dossier.reviews ?? []).map((review) => review.principal_id),
    dossier.oracle?.principal_id,
    dossier.conflict_graph?.principal_id,
  ];
}

function verifyIdentities(errors, dossier) {
  const principals = identityValues(dossier);
  const sessions = [
    dossier.producer?.session_id,
    ...(dossier.reviews ?? []).map((review) => review.session_id),
    dossier.oracle?.session_id,
    dossier.conflict_graph?.session_id,
  ];
  if (!unique(principals))
    add(errors, 'producer/operator/reviewer/oracle/conflict principal alias');
  if (!unique(sessions)) add(errors, 'producer/reviewer/oracle/conflict session alias');
  const expectedPairs = (principals.length * (principals.length - 1)) / 2;
  if (dossier.conflict_graph?.evaluated_pairs !== expectedPairs) {
    add(errors, 'conflict graph does not cover every authority principal pair');
  }
}

function verifyDecision(errors, dossier) {
  const observedAt = Date.parse(dossier.freshness?.observed_at);
  const validUntil = Date.parse(dossier.freshness?.valid_until);
  const complete = [
    dossier.conflict_graph?.result === 'NO_CONFLICTS',
    dossier.oracle?.id === 'd0-admission-oracle-v1',
    dossier.oracle?.result === 'PASS',
    sha64.test(dossier.oracle?.input_digest ?? ''),
    dossier.dissent?.disposition === 'RESOLVED' && dossier.dissent?.unresolved === 0,
    dossier.appellate?.role === 'appellate' && dossier.appellate?.verdict === 'ACCEPTED',
    dossier.freshness?.current === true && observedAt < validUntil,
    Array.isArray(dossier.freshness?.invalidation_keys) &&
      dossier.freshness.invalidation_keys.length,
    Array.isArray(dossier.unresolved_load_bearing_findings) &&
      dossier.unresolved_load_bearing_findings.length === 0,
    dossier.admission?.accepted === true && nonEmptyString(dossier.admission?.reason),
  ].every(Boolean);
  if (!complete) add(errors, 'admission artifacts are incomplete, stale, or non-accepted');
}

function verifyAppellate(errors, dossier) {
  const appellate = dossier.reviews?.find((review) => review.role === 'appellate');
  if (
    !appellate ||
    appellate.principal_id !== dossier.appellate?.principal_id ||
    appellate.report_uri !== dossier.appellate?.report_uri
  ) {
    add(errors, 'appellate identity/report mismatch');
  }
}

export function validateDossierStructure(dossier, policy) {
  const errors = [];
  if (!isRecord(dossier)) return [{ code: 'REVIEW_DOSSIER', message: 'dossier must be an object' }];
  if (!exactKeys(dossier, policy.admission_dossier_keys)) add(errors, 'dossier schema drift');
  if (dossier.schema_version !== '1.0.0' || dossier.contract_id !== policy.contract_id) {
    add(errors, 'dossier identity drift');
  }
  verifyNestedSchemas(errors, dossier);
  verifyTarget(errors, dossier.reviewed_target);
  verifyReviews(errors, dossier, policy);
  verifyArtifactRecord(errors, dossier.conflict_graph, 'conflict');
  verifyArtifactRecord(errors, dossier.oracle, 'oracle');
  verifyIdentities(errors, dossier);
  verifyDecision(errors, dossier);
  verifyAppellate(errors, dossier);
  return errors;
}

export function verifyGatePolicy(errors, gates, policy) {
  if (
    gates.dossier_schema_version !== '1.0.0' ||
    gates.dossier_contract_id !== policy.contract_id ||
    !equal(gates.roles, policy.roles) ||
    !equal(gates.required_artifacts, policy.required_artifacts)
  ) {
    add(errors, 'phase gate dossier identity/roster drift');
  }
}
