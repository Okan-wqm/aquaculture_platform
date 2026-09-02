import { canonicalJson, sha256 } from './canonical.mjs';
import { readCommitFile } from './git-objects.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { verifyReviewerEnvelope } from './review-authority.mjs';
import { validateReviewEvidenceManifest } from './review-evidence-manifest.mjs';

const payloadKeys = [
  'schema_version',
  'contract_id',
  'role',
  'principal_id',
  'session_id',
  'agent_execution_id',
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
    agent_execution_id: review.agent_execution_id,
    capability: review.role,
    reviewed_target_sha256: targetDigest,
    reviewer_authority_bundle_sha256: authorityDigest,
    verdict: review.verdict,
  };
}

function validateEvidence(resources, reportUri, evidence, expected, appellateReviewBundle) {
  if (!Array.isArray(evidence) || evidence.length !== 1) {
    throw new Error('reviewer report must bind exactly one semantic evidence manifest');
  }
  if (new Set(evidence.map((item) => item.artifact_uri)).size !== evidence.length) {
    throw new Error('reviewer report evidence artifact reuse');
  }
  return evidence.map((artifact) => {
    if (!exactKeys(artifact, artifactKeys) || artifact.artifact_uri === reportUri) {
      throw new Error('reviewer report evidence schema or self-reference mismatch');
    }
    const bytes = readSecureArtifact(resources.artifactRoot, artifact.artifact_uri);
    if (artifact.sha256 !== sha256(bytes)) {
      throw new Error('reviewer report evidence artifact digest mismatch');
    }
    return validateReviewEvidenceManifest(bytes, expected, {
      verifySource: (source) =>
        readCommitFile(
          resources.repositoryRoot,
          resources.reviewedHeadSha,
          source,
          resources.gitSession,
        ),
      readArtifact: (uri) => readSecureArtifact(resources.artifactRoot, uri),
      authorityWindow: resources.authorityWindow,
      dossierObservedAt: resources.dossierObservedAt,
      appellateReviewBundle,
      evidenceArtifactUri: artifact.artifact_uri,
      reportUri,
    });
  });
}

function validatePayload(payload, expected, resources, reportUri, appellateReviewBundle) {
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
  const evidenceExpected = Object.fromEntries(
    [
      'role',
      'principal_id',
      'session_id',
      'agent_execution_id',
      'reviewed_target_sha256',
      'reviewer_authority_bundle_sha256',
    ].map((key) => [key, expected[key]]),
  );
  return validateEvidence(
    resources,
    reportUri,
    payload.evidence_artifacts,
    evidenceExpected,
    appellateReviewBundle,
  );
}

function verifyOne(review, credential, resources, appellateReviewBundle) {
  if (
    review.principal_id !== credential.principal_id ||
    review.session_id !== credential.session_id ||
    review.agent_execution_id !== credential.agent_execution_id ||
    !equal(review.capabilities, credential.capabilities)
  ) {
    throw new Error(`${review.role} reviewer identity does not match pinned authority`);
  }
  const bytes = readSecureArtifact(resources.artifactRoot, review.report_uri);
  if (sha256(bytes) !== review.report_sha256) {
    throw new Error(`${review.role} reviewer signed report digest mismatch`);
  }
  const payload = verifyReviewerEnvelope(bytes, credential, 'new-aria-signed-review-report');
  const evidenceManifests = validatePayload(
    payload,
    expectedPayload(review, resources.authorityDigest, resources.targetDigest),
    resources,
    review.report_uri,
    appellateReviewBundle,
  );
  return {
    artifact: { role: review.role, report_uri: review.report_uri, sha256: sha256(bytes) },
    payload,
    evidenceManifest: evidenceManifests[0],
  };
}

function bundleEntry(review, resolved) {
  const evidence = resolved.payload.evidence_artifacts[0];
  return {
    role: review.role,
    report_uri: review.report_uri,
    report_sha256: review.report_sha256,
    evidence_artifact_uri: evidence.artifact_uri,
    evidence_artifact_sha256: evidence.sha256,
    verdict: resolved.payload.verdict,
    ended_at: resolved.evidenceManifest.ended_at,
  };
}

export function orderedReviewBundle(reviews, resolved) {
  if (reviews.length !== resolved.length || reviews.some(({ role }) => role === 'appellate')) {
    throw new Error('appellate ordered review inputs are invalid');
  }
  return reviews.map((review, index) => bundleEntry(review, resolved[index]));
}

export function verifySignedReviews(dossier, authority, resources) {
  const appellateIndex = dossier.reviews.length - 1;
  if (dossier.reviews[appellateIndex]?.role !== 'appellate') {
    throw new Error('appellate review must be the final ordered role');
  }
  const precedingReviews = dossier.reviews.slice(0, appellateIndex);
  const preceding = precedingReviews.map((review, index) =>
    verifyOne(review, authority.reviewers[index], resources, null),
  );
  const bundle = orderedReviewBundle(precedingReviews, preceding);
  const appellate = verifyOne(
    dossier.reviews[appellateIndex],
    authority.reviewers[appellateIndex],
    resources,
    bundle,
  );
  const resolved = [...preceding, appellate];
  for (const [label, values] of [
    ['agent execution', resolved.map((report) => report.payload.agent_execution_id)],
    [
      'evidence manifest',
      resolved.map((report) => report.payload.evidence_artifacts[0].artifact_uri),
    ],
    ['evidence digest', resolved.map((report) => report.payload.evidence_artifacts[0].sha256)],
    ['review ID', resolved.map((report) => report.evidenceManifest.review_id)],
  ]) {
    if (new Set(values).size !== values.length)
      throw new Error(`${label} reuse across review roles`);
  }
  return {
    reportArtifacts: resolved.map((report) => report.artifact),
    reportPayloads: resolved.map((report) => report.payload),
  };
}
