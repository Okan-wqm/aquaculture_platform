import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes } from '../kernel/evidence-object';

export interface VerifyingProjectionInput {
  readonly program_id: string;
  readonly sprint_id: string;
  readonly head_sha: string;
  readonly authority_sha256: string;
  readonly verification_time: string;
  readonly valid_until: string;
  readonly event_chain_sha256: string;
  readonly history_sha256: string;
  readonly object_closure_sha256: string;
  readonly event_policy_sha256: string;
  readonly freshness_policy_sha256: string;
  readonly tail_event_hash: string;
}

export function canonicalVerifyingProjection(input: VerifyingProjectionInput): Buffer {
  return Buffer.concat([
    canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-verifying-projection-v1',
      program_id: input.program_id,
      sprint_id: input.sprint_id,
      state: 'VERIFYING',
      freshness: 'VALID_AT',
      verified_at: input.verification_time,
      valid_until: input.valid_until,
      head_sha: input.head_sha,
      authority_sha256: input.authority_sha256,
      event_chain_sha256: input.event_chain_sha256,
      history_sha256: input.history_sha256,
      object_closure_sha256: input.object_closure_sha256,
      event_policy_sha256: input.event_policy_sha256,
      freshness_policy_sha256: input.freshness_policy_sha256,
      tail_event_hash: input.tail_event_hash,
    }),
    Buffer.from('\n'),
  ]);
}

export const verifyingProjectionSha256 = (bytes: Uint8Array): string => digestBytes(bytes);
