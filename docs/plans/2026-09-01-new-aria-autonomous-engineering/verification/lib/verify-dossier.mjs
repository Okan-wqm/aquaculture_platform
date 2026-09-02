import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './canonical.mjs';

function add(errors, message) {
  errors.push({ code: 'REVIEW_DOSSIER', message });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && equal(Object.keys(value).sort(), [...keys].sort());
}

function unique(values) {
  return new Set(values).size === values.length;
}

const nestedKeys = {
  reviewed_target: ['head_sha', 'authority_bundle_sha256'],
  producer: ['principal_id', 'session_id', 'artifact_uri'],
  conflict_graph: ['result', 'evaluated_pairs'],
  oracle: ['id', 'result', 'input_digest'],
  dissent: ['disposition', 'unresolved'],
  appellate: ['role', 'principal_id', 'report_uri', 'verdict'],
  freshness: ['current', 'observed_at', 'valid_until', 'invalidation_keys'],
  admission: ['accepted', 'reason'],
};

export function loadReviewPolicy(planRoot) {
  return parseStrictJson(readFileSync(join(planRoot, 'verification/review-policy.json'), 'utf8'));
}

function verifyReviewEntry(errors, dossier, review, index) {
  const reviewKeys = [
    'role',
    'principal_id',
    'session_id',
    'report_uri',
    'report_sha256',
    'capabilities',
    'reviewed_head_sha',
    'authority_bundle_sha256',
  ];
  if (!isRecord(review)) {
    add(errors, `review ${index}: record required`);
    return;
  }
  const label = typeof review.role === 'string' ? review.role : `review ${index}`;
  if (!exactKeys(review, reviewKeys)) add(errors, `${label}: review schema open or drifted`);
  if (!equal(review.capabilities, [review.role])) add(errors, `${label}: capability mismatch`);
  if (typeof review.report_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(review.report_sha256)) {
    add(errors, `${label}: report digest is not exact SHA-256`);
  }
  if (!isRecord(dossier.reviewed_target)) {
    add(errors, `${label}: reviewed target missing`);
  } else if (
    review.reviewed_head_sha !== dossier.reviewed_target.head_sha ||
    review.authority_bundle_sha256 !== dossier.reviewed_target.authority_bundle_sha256
  ) {
    add(errors, `${label}: target/authority mismatch`);
  }
}

function verifyReviewEntries(errors, dossier, policy) {
  if (!Array.isArray(dossier.reviews) || dossier.reviews.length !== policy.roles.length) {
    add(errors, 'exact review role count mismatch');
    return;
  }
  dossier.reviews.forEach((review, index) => verifyReviewEntry(errors, dossier, review, index));
  if (
    !equal(
      dossier.reviews.map((review) => review.role),
      policy.roles,
    )
  )
    add(errors, 'role roster drift');
  for (const field of ['principal_id', 'session_id', 'report_uri', 'report_sha256']) {
    if (!unique(dossier.reviews.map((review) => review[field]))) add(errors, `${field} reuse`);
  }
  if (
    isRecord(dossier.producer) &&
    dossier.reviews.some(
      (review) =>
        review.principal_id === dossier.producer.principal_id ||
        review.session_id === dossier.producer.session_id,
    )
  ) {
    add(errors, 'producer principal/session cannot review');
  }
}

function verifyNestedSchemas(errors, dossier) {
  for (const [field, keys] of Object.entries(nestedKeys)) {
    if (!exactKeys(dossier[field], keys)) add(errors, `${field}: schema open or drifted`);
  }
}

function validFreshness(freshness) {
  const observedAt = Date.parse(freshness.observed_at);
  const validUntil = Date.parse(freshness.valid_until);
  return [
    freshness.current === true,
    Array.isArray(freshness.invalidation_keys),
    freshness.invalidation_keys.length > 0,
    Number.isFinite(observedAt),
    Number.isFinite(validUntil),
    observedAt < validUntil,
  ].every(Boolean);
}

function validOracle(oracle) {
  return [
    oracle.id === 'd0-admission-oracle-v1',
    oracle.result === 'PASS',
    typeof oracle.input_digest === 'string',
    /^[a-f0-9]{64}$/u.test(oracle.input_digest),
  ].every(Boolean);
}

function verifyAdmissionArtifacts(errors, dossier) {
  const requiredRecords = [
    'conflict_graph',
    'oracle',
    'dissent',
    'appellate',
    'freshness',
    'admission',
  ];
  if (requiredRecords.some((field) => !isRecord(dossier[field]))) {
    add(errors, 'admission artifacts are missing or malformed');
    return;
  }
  if (!Array.isArray(dossier.unresolved_load_bearing_findings)) {
    add(errors, 'admission artifacts are missing or malformed');
    return;
  }
  const complete = [
    dossier.conflict_graph.result === 'NO_CONFLICTS' &&
      dossier.conflict_graph.evaluated_pairs === 78,
    validOracle(dossier.oracle),
    dossier.dissent.disposition === 'RESOLVED',
    dossier.dissent.unresolved === 0,
    dossier.appellate.verdict === 'ACCEPTED',
    dossier.appellate.role === 'appellate',
    validFreshness(dossier.freshness),
    dossier.unresolved_load_bearing_findings.length === 0,
    dossier.admission.accepted === true,
    typeof dossier.admission.reason === 'string',
    dossier.admission.reason.length > 0,
  ].every(Boolean);
  if (!complete)
    add(errors, 'admission artifacts are incomplete, stale, unresolved, or non-accepted');
}

export function validateAdmissionDossier(dossier, policy) {
  const errors = [];
  if (!isRecord(dossier)) {
    add(errors, 'dossier must be an object');
    return errors;
  }
  if (!exactKeys(dossier, policy.admission_dossier_keys))
    add(errors, 'dossier schema open or drifted');
  if (dossier.schema_version !== '1.0.0' || dossier.contract_id !== policy.contract_id) {
    add(errors, 'dossier identity drift');
  }
  verifyNestedSchemas(errors, dossier);
  verifyReviewEntries(errors, dossier, policy);
  verifyAdmissionArtifacts(errors, dossier);
  const appellate = Array.isArray(dossier.reviews)
    ? dossier.reviews.find((review) => isRecord(review) && review.role === 'appellate')
    : undefined;
  if (
    !isRecord(appellate) ||
    !isRecord(dossier.appellate) ||
    appellate.principal_id !== dossier.appellate.principal_id ||
    appellate.report_uri !== dossier.appellate.report_uri
  ) {
    add(errors, 'appellate identity/report mismatch');
  }
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
