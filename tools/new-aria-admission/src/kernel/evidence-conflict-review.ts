import { canonicalTimestamp } from './evidence-manifest-schema';
import {
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  parseCanonicalEvidenceObject,
  requiredText,
} from './evidence-object';

export interface ConflictReviewExpectation {
  readonly oracle_report_sha256: string;
  readonly negative_controls_sha256: string;
  readonly oracle_observed_at: string;
  readonly reserved_digests: readonly string[];
}

const reviewKeys = ['conflict_verdict', 'conflict_evidence'];
const documentKeys = [
  'schema_version',
  'contract_id',
  'reviewer_principal_id',
  'oracle_principal_id',
  'authority_sha256',
  'target_head_sha',
  'oracle_report_sha256',
  'negative_controls_sha256',
  'reviewed_at',
  'verdict',
  'conflicts',
];

function canonicalTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !canonicalTimestamp.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function validateConflictReview(
  manifest: JsonRecord,
  objects: ReadonlyMap<string, Uint8Array>,
  expected: ConflictReviewExpectation,
): string {
  const review = manifest.review;
  if (
    !isJsonRecord(review) ||
    !hasExactKeys(review, reviewKeys) ||
    review.conflict_verdict !== 'NO_CONFLICT'
  ) {
    throw new TypeError('evidence conflict review is missing or unresolved');
  }
  const proof = parseCanonicalEvidenceObject(
    review.conflict_evidence,
    objects,
    'evidence conflict review',
  );
  const document = proof.document;
  const identities = manifest.identities;
  const target = manifest.target;
  if (
    !isJsonRecord(identities) ||
    !isJsonRecord(target) ||
    !hasExactKeys(document, documentKeys) ||
    document.schema_version !== '1.0.0' ||
    document.contract_id !== 'new-aria-conflict-review-v1' ||
    document.reviewer_principal_id !== identities.reviewer_principal_id ||
    document.oracle_principal_id !== identities.oracle_principal_id ||
    document.authority_sha256 !== manifest.authority_sha256 ||
    document.target_head_sha !== target.head_sha ||
    document.oracle_report_sha256 !== expected.oracle_report_sha256 ||
    document.negative_controls_sha256 !== expected.negative_controls_sha256 ||
    document.verdict !== 'NO_CONFLICT' ||
    !Array.isArray(document.conflicts) ||
    document.conflicts.length !== 0
  ) {
    throw new TypeError('evidence conflict review does not match admitted evidence');
  }
  const reviewedAt = canonicalTime(document.reviewed_at, 'conflict review timestamp');
  const manifestObservedAt = requiredText(manifest.observed_at, 'manifest observation timestamp');
  if (
    Date.parse(reviewedAt) < Date.parse(expected.oracle_observed_at) ||
    Date.parse(reviewedAt) > Date.parse(manifestObservedAt)
  ) {
    throw new TypeError('evidence conflict review timestamp is not ordered');
  }
  if (expected.reserved_digests.includes(proof.reference.sha256)) {
    throw new TypeError('evidence conflict review object is reused');
  }
  return proof.reference.sha256;
}
