import { canonicalJson, sha256 } from './canonical.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { verifyReviewerEnvelope } from './review-authority.mjs';

const conflictKeys = [
  'schema_version',
  'contract_id',
  'principal_id',
  'session_id',
  'capability',
  'reviewed_target_sha256',
  'reviewer_authority_bundle_sha256',
  'participant_principal_ids',
  'pairs',
  'result',
];
const oracleKeys = [
  'schema_version',
  'contract_id',
  'oracle_id',
  'principal_id',
  'session_id',
  'capability',
  'reviewed_target_sha256',
  'reviewer_authority_bundle_sha256',
  'input_digest',
  'result',
];
const pairKeys = ['left_principal_id', 'right_principal_id', 'result'];

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

function identityRoster(dossier, authority) {
  return [
    dossier.producer.principal_id,
    dossier.reviewed_target.target_operator_principal_id,
    dossier.admission.operator_principal_id,
    ...authority.reviewers.map((credential) => credential.principal_id),
    authority.oracle.principal_id,
    authority.conflict.principal_id,
  ];
}

export function conflictPairs(principals) {
  return principals.flatMap((left, index) =>
    principals.slice(index + 1).map((right) => ({
      left_principal_id: left,
      right_principal_id: right,
      result: 'NO_CONFLICT',
    })),
  );
}

function conflictExpectation(dossier, authority, resources) {
  const principals = identityRoster(dossier, authority);
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-conflict-v1',
    principal_id: authority.conflict.principal_id,
    session_id: authority.conflict.session_id,
    capability: 'd0-conflict-oracle',
    reviewed_target_sha256: resources.targetDigest,
    reviewer_authority_bundle_sha256: resources.authorityDigest,
    participant_principal_ids: principals,
    pairs: conflictPairs(principals),
    result: 'NO_CONFLICTS',
  };
}

function verifyConflictDossier(dossier, credential, payload, bytes) {
  const graph = dossier.conflict_graph;
  const expected = {
    result: payload.result,
    evaluated_pairs: payload.pairs.length,
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    envelope_uri: graph.envelope_uri,
    envelope_sha256: sha256(bytes),
  };
  if (!equal(graph, expected)) throw new Error('dossier conflict graph contradicts signed result');
}

export function verifySignedConflict(dossier, authority, resources) {
  const graph = dossier.conflict_graph;
  const bytes = readSecureArtifact(resources.artifactRoot, graph.envelope_uri);
  if (sha256(bytes) !== graph.envelope_sha256) {
    throw new Error('signed conflict envelope digest mismatch');
  }
  const payload = verifyReviewerEnvelope(
    bytes,
    authority.conflict,
    'new-aria-signed-review-conflict',
  );
  if (
    !exactKeys(payload, conflictKeys) ||
    !Array.isArray(payload.pairs) ||
    payload.pairs.some((pair) => !exactKeys(pair, pairKeys)) ||
    !equal(payload, conflictExpectation(dossier, authority, resources))
  ) {
    throw new Error('signed conflict payload is not the complete deterministic identity graph');
  }
  verifyConflictDossier(dossier, authority.conflict, payload, bytes);
  return payload;
}

export function oracleInputDigest(resources, conflictPayload) {
  return sha256(
    Buffer.from(
      canonicalJson({
        contract_id: 'new-aria-review-oracle-input-v1',
        reviewed_target: resources.reviewedTarget,
        reviewer_authority_bundle_sha256: resources.authorityDigest,
        review_policy_sha256: resources.policyDigest,
        admitted_report_payloads: resources.reportPayloads,
        admitted_conflict_payload: conflictPayload,
      }),
      'utf8',
    ),
  );
}

function computedResult(reportPayloads, conflictPayload) {
  const accepted = reportPayloads.every(
    (report) =>
      report.verdict === 'ACCEPTED' &&
      report.unresolved_load_bearing_findings.length === 0 &&
      report.evidence_artifacts.length > 0,
  );
  return accepted && conflictPayload.result === 'NO_CONFLICTS' ? 'PASS' : 'FAIL';
}

function oracleExpectation(authority, resources, conflictPayload) {
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-oracle-v1',
    oracle_id: 'd0-admission-oracle-v1',
    principal_id: authority.oracle.principal_id,
    session_id: authority.oracle.session_id,
    capability: 'd0-review-oracle',
    reviewed_target_sha256: resources.targetDigest,
    reviewer_authority_bundle_sha256: resources.authorityDigest,
    input_digest: oracleInputDigest(resources, conflictPayload),
    result: computedResult(resources.reportPayloads, conflictPayload),
  };
}

function verifyOracleDossier(dossier, credential, payload, bytes) {
  const expected = {
    id: payload.oracle_id,
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    envelope_uri: dossier.oracle.envelope_uri,
    envelope_sha256: sha256(bytes),
    result: payload.result,
    input_digest: payload.input_digest,
  };
  if (!equal(dossier.oracle, expected)) throw new Error('dossier oracle contradicts signed result');
}

export function verifySignedOracle(dossier, authority, resources, conflictPayload) {
  const bytes = readSecureArtifact(resources.artifactRoot, dossier.oracle.envelope_uri);
  if (sha256(bytes) !== dossier.oracle.envelope_sha256) {
    throw new Error('signed deterministic oracle envelope digest mismatch');
  }
  const payload = verifyReviewerEnvelope(bytes, authority.oracle, 'new-aria-signed-review-oracle');
  const expected = oracleExpectation(authority, resources, conflictPayload);
  if (!exactKeys(payload, oracleKeys) || !equal(payload, expected) || payload.result !== 'PASS') {
    throw new Error('signed deterministic oracle input or result mismatch');
  }
  verifyOracleDossier(dossier, authority.oracle, payload, bytes);
  return payload;
}

export function verifyDossierDecision(dossier, reportPayloads) {
  const appellateIndex = reportPayloads.findIndex((report) => report.role === 'appellate');
  const appellate = reportPayloads[appellateIndex];
  const review = dossier.reviews[appellateIndex];
  const expectedAppellate = {
    role: 'appellate',
    principal_id: appellate?.principal_id,
    report_uri: review?.report_uri,
    verdict: appellate?.verdict,
  };
  const unresolved = reportPayloads.flatMap((report) => report.unresolved_load_bearing_findings);
  if (
    !equal(dossier.appellate, expectedAppellate) ||
    !equal(dossier.dissent, { disposition: 'RESOLVED', unresolved: unresolved.length }) ||
    !equal(dossier.unresolved_load_bearing_findings, unresolved) ||
    !equal(dossier.admission.accepted, unresolved.length === 0)
  ) {
    throw new Error('dossier appellate, dissent, finding, or admission decision mismatch');
  }
}
