import { canonicalJson, sha256 } from './canonical.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { verifyReviewerEnvelope } from './review-authority.mjs';

const payloadKeys = [
  'schema_version',
  'contract_id',
  'role',
  'principal_id',
  'session_id',
  'capability',
  'reviewed_target_sha256',
  'reviewer_authority_bundle_sha256',
  'verdict',
  'evidence_artifacts',
  'unresolved_load_bearing_findings',
];
const artifactKeys = ['artifact_uri', 'sha256'];

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

function expectedPayload(review, authorityDigest, targetDigest) {
  return {
    role: review.role,
    principal_id: review.principal_id,
    session_id: review.session_id,
    capability: review.role,
    reviewed_target_sha256: targetDigest,
    reviewer_authority_bundle_sha256: authorityDigest,
    verdict: review.verdict,
  };
}

function validateEvidence(artifactRoot, reportUri, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('reviewer report must bind at least one evidence artifact');
  }
  if (new Set(evidence.map((item) => item.artifact_uri)).size !== evidence.length) {
    throw new Error('reviewer report evidence artifact reuse');
  }
  for (const artifact of evidence) {
    if (!exactKeys(artifact, artifactKeys) || artifact.artifact_uri === reportUri) {
      throw new Error('reviewer report evidence schema or self-reference mismatch');
    }
    const bytes = readSecureArtifact(artifactRoot, artifact.artifact_uri);
    if (artifact.sha256 !== sha256(bytes)) {
      throw new Error('reviewer report evidence artifact digest mismatch');
    }
  }
}

function validatePayload(payload, expected, artifactRoot, reportUri) {
  if (
    !exactKeys(payload, payloadKeys) ||
    payload.schema_version !== '1.0.0' ||
    payload.contract_id !== 'new-aria-review-report-v1'
  ) {
    throw new Error('reviewer report payload schema or contract mismatch');
  }
  const semantics = Object.fromEntries(Object.keys(expected).map((key) => [key, payload[key]]));
  if (!equal(semantics, expected)) throw new Error('reviewer report semantic binding mismatch');
  if (payload.verdict !== 'ACCEPTED' || payload.unresolved_load_bearing_findings.length !== 0) {
    throw new Error('reviewer report is not accepted or has unresolved load-bearing findings');
  }
  validateEvidence(artifactRoot, reportUri, payload.evidence_artifacts);
}

function verifyOne(review, credential, resources) {
  if (
    review.principal_id !== credential.principal_id ||
    review.session_id !== credential.session_id ||
    !equal(review.capabilities, credential.capabilities)
  ) {
    throw new Error(`${review.role} reviewer identity does not match pinned authority`);
  }
  const bytes = readSecureArtifact(resources.artifactRoot, review.report_uri);
  if (sha256(bytes) !== review.report_sha256) {
    throw new Error(`${review.role} reviewer signed report digest mismatch`);
  }
  const payload = verifyReviewerEnvelope(bytes, credential, 'new-aria-signed-review-report');
  validatePayload(
    payload,
    expectedPayload(review, resources.authorityDigest, resources.targetDigest),
    resources.artifactRoot,
    review.report_uri,
  );
  return {
    artifact: { role: review.role, report_uri: review.report_uri, sha256: sha256(bytes) },
    payload,
  };
}

export function verifySignedReviews(dossier, authority, resources) {
  const resolved = dossier.reviews.map((review, index) =>
    verifyOne(review, authority.reviewers[index], resources),
  );
  return {
    reportArtifacts: resolved.map((report) => report.artifact),
    reportPayloads: resolved.map((report) => report.payload),
  };
}
