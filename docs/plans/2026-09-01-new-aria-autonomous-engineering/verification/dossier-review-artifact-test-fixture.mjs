import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { readCommitFile } from './lib/git-objects.mjs';
import { REVIEW_ROLE_POLICY } from './lib/review-evidence-policy.mjs';
import { signedEnvelope, writeArtifact } from './dossier-crypto-test-fixture.mjs';

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
    agent_execution_id: credential.agent_execution_id,
    capability: role,
    reviewed_target_sha256: targetDigest,
    reviewer_authority_bundle_sha256: authorityDigest,
    verdict: 'ACCEPTED',
    evidence_artifacts: [evidence],
    unresolved_load_bearing_findings: [],
  };
}

function reviewTimes(resources, index) {
  const origin = Date.parse(resources.authority.bundle.observed_at) + index * 1_000;
  return {
    started_at: new Date(origin + 100).toISOString(),
    control_started_at: new Date(origin + 200).toISOString(),
    control_ended_at: new Date(origin + 600).toISOString(),
    ended_at: new Date(origin + 900).toISOString(),
  };
}

function inspectedSource(resources, path) {
  const committed = readCommitFile(
    resources.repositoryRoot,
    resources.target.head_sha,
    { path },
    resources.gitTool,
  );
  return { path, blob_oid: committed.oid, sha256: sha256(committed.bytes) };
}

function negativeResult(resources, policy, times) {
  const output = writeArtifact(
    resources.artifactRoot,
    policy.artifact_uri,
    Buffer.from(`${policy.output_marker}\n`, 'utf8'),
  );
  return {
    control_id: policy.control_id,
    argv: policy.argv,
    argv_sha256: sha256(Buffer.from(canonicalJson(policy.argv), 'utf8')),
    exit_code: 0,
    result: 'MUTANTS_REJECTED',
    output_artifact: output,
    started_at: times.control_started_at,
    ended_at: times.control_ended_at,
  };
}

function evidencePayload(resources, spec) {
  const { role, credential, targetDigest, index, appellateBundle } = spec;
  const policy = REVIEW_ROLE_POLICY[role];
  const source = inspectedSource(resources, policy.source_paths[0]);
  const times = reviewTimes(resources, index);
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-review-evidence-v1',
    review_id: `d0-${role}-review-${index}`,
    role,
    principal_id: credential.principal_id,
    session_id: credential.session_id,
    agent_execution_id: credential.agent_execution_id,
    reviewed_target_sha256: targetDigest,
    reviewer_authority_bundle_sha256: resources.authority.sha256,
    independence_assurance: 'OPERATOR_ATTESTED',
    method: 'ADVERSARIAL_SOURCE_REVIEW',
    scope: [policy.scope],
    inspected_sources: [source],
    control_results: [
      { control_id: policy.control_id, result: 'PASS', evidence_refs: [source.path] },
    ],
    negative_controls: [negativeResult(resources, policy.negative_control, times)],
    appellate_review_bundle: appellateBundle,
    findings: [],
    started_at: times.started_at,
    ended_at: times.ended_at,
    verdict: 'ACCEPTED',
    unresolved_load_bearing_findings: [],
  };
}

function writeReview(resources, spec) {
  const { role, signer, index, targetDigest } = spec;
  const evidenceManifest = evidencePayload(resources, {
    ...spec,
    credential: signer.credential,
  });
  const evidence = writeArtifact(
    resources.artifactRoot,
    `evidence/${index}-${role}.json`,
    Buffer.from(`${canonicalJson(evidenceManifest)}\n`, 'utf8'),
  );
  const payload = reviewPayload(
    role,
    signer.credential,
    targetDigest,
    resources.authority.sha256,
    evidence,
  );
  const report = writeArtifact(
    resources.artifactRoot,
    `reports/${index}-${role}.json`,
    signedEnvelope('new-aria-signed-review-report', payload, signer),
  );
  return {
    review: {
      role,
      principal_id: signer.credential.principal_id,
      session_id: signer.credential.session_id,
      agent_execution_id: signer.credential.agent_execution_id,
      report_uri: report.artifact_uri,
      report_sha256: report.sha256,
      capabilities: [role],
      reviewed_head_sha: resources.target.head_sha,
      authority_bundle_sha256: resources.target.authority_bundle_sha256,
      reviewed_target_sha256: targetDigest,
      reviewer_authority_bundle_sha256: resources.authority.sha256,
      verdict: 'ACCEPTED',
    },
    payload,
    evidenceManifest,
  };
}

function bundleEntry(written) {
  const evidence = written.payload.evidence_artifacts[0];
  return {
    role: written.review.role,
    report_uri: written.review.report_uri,
    report_sha256: written.review.report_sha256,
    evidence_artifact_uri: evidence.artifact_uri,
    evidence_artifact_sha256: evidence.sha256,
    verdict: written.payload.verdict,
    ended_at: written.evidenceManifest.ended_at,
  };
}

export function writeReviews(resources) {
  const targetDigest = digest(resources.target);
  const last = resources.authority.reviewerSigners.length - 1;
  const preceding = resources.authority.reviewerSigners.slice(0, last).map((signer, index) =>
    writeReview(resources, {
      signer,
      index,
      role: resources.policy.roles[index],
      targetDigest,
      appellateBundle: null,
    }),
  );
  const appellate = writeReview(resources, {
    signer: resources.authority.reviewerSigners[last],
    index: last,
    role: resources.policy.roles[last],
    targetDigest,
    appellateBundle: preceding.map(bundleEntry),
  });
  const written = [...preceding, appellate];
  return {
    reviews: written.map(({ review }) => review),
    reportPayloads: written.map(({ payload }) => payload),
  };
}
