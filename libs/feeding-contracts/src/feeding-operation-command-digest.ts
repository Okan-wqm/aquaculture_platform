import {
  canonicalJsonSha256,
  createCanonicalJsonDocumentV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';

/**
 * One hash domain for every persisted feeding command payload. The payload is
 * already a strict canonical snapshot; callers cannot hash mutable runtime
 * objects or invent a job-specific serialization policy.
 */
export const FEEDING_OPERATION_COMMAND_HASH_AUTHORITY_V1 = Object.freeze({
  domain: 'aquaculture.feeding-operation-command',
  schemaVersion: 'feeding-operation-command/v1',
} as const);

export function feedingOperationCommandDigestV1(payload: CanonicalJsonValue): string {
  return canonicalJsonSha256(
    FEEDING_OPERATION_COMMAND_HASH_AUTHORITY_V1,
    createCanonicalJsonDocumentV1(payload),
  );
}
