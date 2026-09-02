import { canonicalJson, parseStrictJsonBytes } from './canonical.mjs';
import { REQUIRED_ROLE_CONTROL } from './review-evidence-policy.mjs';
import { validateReviewEvidenceSemantics } from './review-evidence-semantics.mjs';

export { REQUIRED_ROLE_CONTROL };

const manifestKeys = [
  'schema_version',
  'contract_id',
  'review_id',
  'role',
  'principal_id',
  'session_id',
  'agent_execution_id',
  'reviewed_target_sha256',
  'reviewer_authority_bundle_sha256',
  'independence_assurance',
  'method',
  'scope',
  'inspected_sources',
  'control_results',
  'negative_controls',
  'appellate_review_bundle',
  'findings',
  'started_at',
  'ended_at',
  'verdict',
  'unresolved_load_bearing_findings',
];
const sourceKeys = ['path', 'blob_oid', 'sha256'];
const controlKeys = ['control_id', 'result', 'evidence_refs'];
const negativeKeys = [
  'control_id',
  'argv',
  'argv_sha256',
  'exit_code',
  'result',
  'output_artifact',
  'started_at',
  'ended_at',
];
const findingKeys = ['id', 'severity', 'path', 'line', 'reproduction', 'disposition'];
const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !value?.length)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

function portableSourcePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').includes('..')
  );
}

function validateSource(source) {
  if (!exactKeys(source, sourceKeys) || !portableSourcePath(source?.path)) {
    throw new Error('inspected source schema or path is invalid');
  }
  if (!sha40.test(source.blob_oid) || !sha64.test(source.sha256)) {
    throw new Error('inspected source digest is invalid');
  }
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('review evidence must cite at least one inspected source');
  }
  sources.forEach(validateSource);
  uniqueStrings(
    sources.map((source) => source.path),
    'inspected source paths',
  );
}

function validateControls(manifest) {
  if (!Array.isArray(manifest.control_results) || manifest.control_results.length === 0) {
    throw new Error('review evidence control results are required');
  }
  const sourcePaths = new Set(manifest.inspected_sources.map((source) => source.path));
  for (const control of manifest.control_results) {
    if (!exactKeys(control, controlKeys) || control.result !== 'PASS') {
      throw new Error('review evidence control result is invalid');
    }
    requiredString(control.control_id, 'review control ID');
    uniqueStrings(control.evidence_refs, 'review control evidence references');
    if (control.evidence_refs.some((reference) => !sourcePaths.has(reference))) {
      throw new Error('review control evidence reference is not an inspected source');
    }
  }
  const controlIds = manifest.control_results.map((control) => control.control_id);
  if (
    new Set(controlIds).size !== controlIds.length ||
    !controlIds.includes(REQUIRED_ROLE_CONTROL[manifest.role])
  ) {
    throw new Error('required role control is missing or duplicated');
  }
}

function validateNegativeControl(control) {
  if (!exactKeys(control, negativeKeys)) throw new Error('negative control schema is invalid');
  requiredString(control.control_id, 'negative control ID');
  uniqueStrings(control.argv, 'negative control argv');
  if (!sha64.test(control.argv_sha256)) {
    throw new Error('negative control digest is invalid');
  }
  if (
    !Number.isSafeInteger(control.exit_code) ||
    control.exit_code !== 0 ||
    control.result !== 'MUTANTS_REJECTED'
  ) {
    throw new Error('executed negative control outcome is invalid');
  }
}

function validateNegativeControls(controls) {
  if (!Array.isArray(controls) || controls.length === 0) {
    throw new Error('at least one executed negative control is required');
  }
  controls.forEach(validateNegativeControl);
}

function validateFinding(finding) {
  if (!exactKeys(finding, findingKeys)) throw new Error('review finding schema is invalid');
  if (!['P0', 'P1', 'P2', 'P3'].includes(finding.severity)) {
    throw new Error('review finding severity is invalid');
  }
  if (!Number.isSafeInteger(finding.line) || finding.line < 1) {
    throw new Error('review finding line is invalid');
  }
  if (finding.disposition !== 'RESOLVED') throw new Error('review finding is unresolved');
  for (const field of ['id', 'path', 'reproduction']) requiredString(finding[field], field);
}

function validateFindings(manifest) {
  if (!Array.isArray(manifest.findings)) throw new Error('review findings must be an array');
  manifest.findings.forEach(validateFinding);
  if (
    manifest.verdict !== 'ACCEPTED' ||
    !Array.isArray(manifest.unresolved_load_bearing_findings) ||
    manifest.unresolved_load_bearing_findings.length !== 0
  ) {
    throw new Error('accepted review cannot contain unresolved load-bearing findings');
  }
}

function validateIdentity(manifest, expected) {
  for (const field of Object.keys(expected)) {
    if (manifest[field] !== expected[field])
      throw new Error('review evidence semantic binding mismatch');
  }
  if (
    manifest.schema_version !== '1.0.0' ||
    manifest.contract_id !== 'new-aria-review-evidence-v1' ||
    manifest.independence_assurance !== 'OPERATOR_ATTESTED' ||
    manifest.method !== 'ADVERSARIAL_SOURCE_REVIEW'
  ) {
    throw new Error('review evidence identity or assurance mismatch');
  }
  for (const field of ['review_id', 'agent_execution_id']) requiredString(manifest[field], field);
  if (!sha64.test(manifest.reviewed_target_sha256)) throw new Error('target digest is invalid');
  if (!sha64.test(manifest.reviewer_authority_bundle_sha256)) {
    throw new Error('reviewer authority digest is invalid');
  }
}

export function validateReviewEvidenceManifest(bytes, expected, context) {
  let manifest;
  try {
    manifest = parseStrictJsonBytes(bytes, 'review evidence manifest');
  } catch (error) {
    throw new Error(`review evidence is not strict JSON: ${error.message}`);
  }
  if (!exactKeys(manifest, manifestKeys))
    throw new Error('review evidence schema is open or drifted');
  if (!bytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'))) {
    throw new Error('review evidence manifest is not canonical newline-terminated JSON');
  }
  validateIdentity(manifest, expected);
  uniqueStrings(manifest.scope, 'review scope');
  validateSources(manifest.inspected_sources);
  if (typeof context?.verifySource !== 'function') {
    throw new Error('review evidence source verifier is required');
  }
  manifest.inspected_sources.forEach((source) => context.verifySource(source));
  validateControls(manifest);
  validateNegativeControls(manifest.negative_controls);
  validateFindings(manifest);
  validateReviewEvidenceSemantics(manifest, context);
  return manifest;
}
