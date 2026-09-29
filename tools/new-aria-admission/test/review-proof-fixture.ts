import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

interface ConflictReviewInput {
  readonly authority_sha256: string;
  readonly target_head_sha: string;
  readonly oracle_report_sha256: string;
  readonly negative_controls: unknown;
  readonly reviewed_at: string;
}

export function conflictReviewProof(input: ConflictReviewInput): {
  readonly reference: { readonly uri: string; readonly sha256: string };
  readonly bytes: Uint8Array;
} {
  const negativeControlsSha256 = createHash('sha256')
    .update(canonicalJsonBytes(input.negative_controls))
    .digest('hex');
  const document = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-conflict-review-v1',
    reviewer_principal_id: 'reviewer-1',
    oracle_principal_id: 'oracle-1',
    authority_sha256: input.authority_sha256,
    target_head_sha: input.target_head_sha,
    oracle_report_sha256: input.oracle_report_sha256,
    negative_controls_sha256: negativeControlsSha256,
    reviewed_at: input.reviewed_at,
    verdict: 'NO_CONFLICT',
    conflicts: [],
  };
  const bytes = canonicalJsonBytes(document);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    reference: { uri: `aria-evidence://sha256/${sha256}`, sha256 },
    bytes,
  };
}
