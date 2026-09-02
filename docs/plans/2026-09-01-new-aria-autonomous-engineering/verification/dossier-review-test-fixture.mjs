import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { conflictPairs } from './lib/review-oracle.mjs';
import { signedEnvelope, writeArtifact } from './dossier-crypto-test-fixture.mjs';

const admissionPrincipal = 'admission-operator';

function digest(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function reviewPayload(role, credential, targetDigest, authorityDigest, evidence) {
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-report-v1',
    role,
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    capability: role,
    reviewed_target_sha256: targetDigest,
    reviewer_authority_bundle_sha256: authorityDigest,
    verdict: 'ACCEPTED',
    evidence_artifacts: [evidence],
    unresolved_load_bearing_findings: [],
  };
}

function writeReviews(resources) {
  const targetDigest = digest(resources.target);
  const reportPayloads = [];
  const reviews = resources.authority.reviewerSigners.map((signer, index) => {
    const role = resources.policy.roles[index];
    const evidence = writeArtifact(
      resources.artifactRoot,
      `evidence/${index}-${role}.md`,
      Buffer.from(`independent evidence ${index} ${role}\n`, 'utf8'),
    );
    const payload = reviewPayload(
      role,
      signer.credential,
      targetDigest,
      resources.authority.sha256,
      evidence,
    );
    reportPayloads.push(payload);
    const report = writeArtifact(
      resources.artifactRoot,
      `reports/${index}-${role}.json`,
      signedEnvelope('new-aria-signed-review-report', payload, signer),
    );
    return {
      role,
      principal_id: signer.credential.principal_id,
      session_id: signer.credential.session_id,
      report_uri: report.artifact_uri,
      report_sha256: report.sha256,
      capabilities: [role],
      reviewed_head_sha: resources.target.head_sha,
      authority_bundle_sha256: resources.target.authority_bundle_sha256,
      reviewed_target_sha256: targetDigest,
      reviewer_authority_bundle_sha256: resources.authority.sha256,
      verdict: 'ACCEPTED',
    };
  });
  return { reviews, reportPayloads };
}

function identityRoster(resources, reviews) {
  return [
    resources.producer.principal_id,
    resources.target.target_operator_principal_id,
    admissionPrincipal,
    ...reviews.map((review) => review.principal_id),
    resources.authority.oracleSigner.credential.principal_id,
    resources.authority.conflictSigner.credential.principal_id,
  ];
}

function writeConflict(resources, reviews) {
  const principals = identityRoster(resources, reviews);
  const credential = resources.authority.conflictSigner.credential;
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-conflict-v1',
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    capability: 'd0-conflict-oracle',
    reviewed_target_sha256: digest(resources.target),
    reviewer_authority_bundle_sha256: resources.authority.sha256,
    participant_principal_ids: principals,
    pairs: conflictPairs(principals),
    result: 'NO_CONFLICTS',
  };
  const artifact = writeArtifact(
    resources.artifactRoot,
    'decisions/conflict.json',
    signedEnvelope('new-aria-signed-review-conflict', payload, resources.authority.conflictSigner),
  );
  return { payload, artifact };
}

function oracleDigest(resources, reportPayloads, conflict) {
  return digest({
    contract_id: 'new-aria-review-oracle-input-v1',
    reviewed_target: resources.target,
    reviewer_authority_bundle_sha256: resources.authority.sha256,
    review_policy_sha256: digest(resources.policy),
    admitted_report_payloads: reportPayloads,
    admitted_conflict_payload: conflict,
  });
}

function writeOracle(resources, reports, conflict) {
  const credential = resources.authority.oracleSigner.credential;
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-oracle-v1',
    oracle_id: 'd0-admission-oracle-v1',
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    capability: 'd0-review-oracle',
    reviewed_target_sha256: digest(resources.target),
    reviewer_authority_bundle_sha256: resources.authority.sha256,
    input_digest: oracleDigest(resources, reports, conflict),
    result: 'PASS',
  };
  const artifact = writeArtifact(
    resources.artifactRoot,
    'decisions/oracle.json',
    signedEnvelope('new-aria-signed-review-oracle', payload, resources.authority.oracleSigner),
  );
  return { payload, artifact };
}

function assembleDossier(resources, reports, conflict, oracle) {
  const appellate = reports.reviews.at(-1);
  return {
    schema_version: '1.0.0',
    contract_id: resources.policy.contract_id,
    reviewed_target: resources.target,
    producer: resources.producer,
    reviews: reports.reviews,
    conflict_graph: {
      result: conflict.payload.result,
      evaluated_pairs: conflict.payload.pairs.length,
      principal_id: conflict.payload.principal_id,
      session_id: conflict.payload.session_id,
      envelope_uri: conflict.artifact.artifact_uri,
      envelope_sha256: conflict.artifact.sha256,
    },
    oracle: {
      id: oracle.payload.oracle_id,
      principal_id: oracle.payload.principal_id,
      session_id: oracle.payload.session_id,
      envelope_uri: oracle.artifact.artifact_uri,
      envelope_sha256: oracle.artifact.sha256,
      result: oracle.payload.result,
      input_digest: oracle.payload.input_digest,
    },
    dissent: { disposition: 'RESOLVED', unresolved: 0 },
    appellate: {
      role: 'appellate',
      principal_id: appellate.principal_id,
      report_uri: appellate.report_uri,
      verdict: appellate.verdict,
    },
    unresolved_load_bearing_findings: [],
    freshness: {
      current: true,
      observed_at: resources.freshness.observedAt,
      valid_until: resources.freshness.validUntil,
      invalidation_keys: resources.policy.admission_context.required_invalidation_keys,
    },
    admission: {
      accepted: true,
      operator_principal_id: admissionPrincipal,
      reason: 'Exact independently signed dossier accepted.',
    },
  };
}

export function createReviewDossier(resources) {
  const reports = writeReviews(resources);
  const conflict = writeConflict(resources, reports.reviews);
  const oracle = writeOracle(resources, reports.reportPayloads, conflict.payload);
  return {
    dossier: assembleDossier(resources, reports, conflict, oracle),
    reportPayloads: reports.reportPayloads,
    conflict,
    oracle,
  };
}
