import { canonicalJson, sha256 } from './canonical.mjs';
import { REVIEW_ROLE_POLICY } from './review-evidence-policy.mjs';

const artifactKeys = ['artifact_uri', 'sha256'];
const bundleKeys = [
  'role',
  'report_uri',
  'report_sha256',
  'evidence_artifact_uri',
  'evidence_artifact_sha256',
  'verdict',
  'ended_at',
];
const sha64 = /^[a-f0-9]{64}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort())
  );
}

function time(value, label) {
  const parsed = Date.parse(value);
  if (!timestamp.test(value) || !Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function validateRolePolicy(manifest, policy) {
  const sourcePaths = manifest.inspected_sources.map(({ path }) => path);
  const expectedControl = {
    control_id: policy.control_id,
    result: 'PASS',
    evidence_refs: policy.source_paths,
  };
  if (!equal(manifest.scope, [policy.scope]) || !equal(sourcePaths, policy.source_paths)) {
    throw new Error('review role source policy mismatch');
  }
  if (!equal(manifest.control_results, [expectedControl])) {
    throw new Error('review role control policy mismatch');
  }
}

function validateOutputArtifact(control, policy, context) {
  if (!exactKeys(control.output_artifact, artifactKeys)) {
    throw new Error('negative-control output artifact schema is invalid');
  }
  const uri = control.output_artifact.artifact_uri;
  if ([context.evidenceArtifactUri, context.reportUri].includes(uri)) {
    throw new Error('negative-control artifact self-reference is forbidden');
  }
  if (uri !== policy.artifact_uri) {
    throw new Error('review role output artifact policy mismatch');
  }
  if (typeof context.readArtifact !== 'function') {
    throw new Error('negative-control artifact reader required');
  }
  const bytes = context.readArtifact(uri);
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== control.output_artifact.sha256) {
    throw new Error('negative-control output artifact digest mismatch');
  }
  if (!bytes.equals(Buffer.from(`${policy.output_marker}\n`, 'utf8'))) {
    throw new Error('negative-control output marker mismatch');
  }
}

function validateNegativeControl(manifest, policy, context) {
  if (manifest.negative_controls.length !== 1) {
    throw new Error('exactly one role negative control is required');
  }
  const control = manifest.negative_controls[0];
  const argvDigest = sha256(Buffer.from(canonicalJson(control.argv), 'utf8'));
  if (
    control.control_id !== policy.control_id ||
    !equal(control.argv, policy.argv) ||
    control.argv_sha256 !== argvDigest ||
    control.exit_code !== 0 ||
    control.result !== 'MUTANTS_REJECTED'
  ) {
    throw new Error('review role negative-control policy mismatch');
  }
  validateOutputArtifact(control, policy, context);
}

function validateAuthorityClock(manifest, context) {
  const started = time(manifest.started_at, 'review start');
  const ended = time(manifest.ended_at, 'review end');
  const authorityStart = time(context.authorityWindow?.observed_at, 'authority window start');
  const authorityEnd = time(context.authorityWindow?.valid_until, 'authority window end');
  const dossierObserved = time(context.dossierObservedAt, 'dossier observation');
  if (started < authorityStart || ended > authorityEnd || ended > dossierObserved) {
    throw new Error('review evidence clock is outside its authority window');
  }
  const control = manifest.negative_controls[0];
  const controlStart = time(control.started_at, 'negative-control start');
  const controlEnd = time(control.ended_at, 'negative-control end');
  if (controlStart < started || controlStart >= controlEnd || controlEnd > ended) {
    throw new Error('negative-control temporal binding mismatch');
  }
}

function validateBundleRecord(record) {
  if (
    !exactKeys(record, bundleKeys) ||
    !sha64.test(record.report_sha256) ||
    !sha64.test(record.evidence_artifact_sha256) ||
    record.verdict !== 'ACCEPTED'
  ) {
    throw new Error('appellate ordered review bundle record is invalid');
  }
  for (const field of ['role', 'report_uri', 'evidence_artifact_uri']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error('appellate ordered review bundle record is invalid');
    }
  }
  time(record.ended_at, 'appellate input end');
}

function validateAppellateBundle(manifest, expected) {
  if (manifest.role !== 'appellate') {
    if (manifest.appellate_review_bundle !== null || expected !== null) {
      throw new Error('non-appellate review cannot carry an appellate review bundle');
    }
    return;
  }
  if (
    !Array.isArray(expected) ||
    expected.length !== 11 ||
    !equal(manifest.appellate_review_bundle, expected)
  ) {
    throw new Error('appellate ordered review bundle mismatch');
  }
  expected.forEach(validateBundleRecord);
  const latestInput = Math.max(
    ...expected.map(({ ended_at: endedAt }) => time(endedAt, 'input end')),
  );
  if (time(manifest.started_at, 'appellate start') < latestInput) {
    throw new Error('appellate review must start after every ordered review input');
  }
}

export function validateReviewEvidenceSemantics(manifest, context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('review evidence validation context is required');
  }
  const policy = REVIEW_ROLE_POLICY[manifest.role];
  if (!policy) throw new Error('review role policy is missing');
  validateRolePolicy(manifest, policy);
  validateNegativeControl(manifest, policy.negative_control, context);
  validateAuthorityClock(manifest, context);
  validateAppellateBundle(manifest, context.appellateReviewBundle);
}
