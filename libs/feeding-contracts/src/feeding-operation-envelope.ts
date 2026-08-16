import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';

import { freezeAuthorityGraphV1 } from './authority-immutability';
import type { FeedingJobId } from './feeding-job-catalog';

export const FEEDING_OPERATION_ENVELOPE_HASH_AUTHORITY_V1 = freezeAuthorityGraphV1({
  domain: 'aquaculture.feeding-operation-envelope',
  schemaVersion: 'feeding-operation-envelope/v1',
} as const);

export interface FeedingOperationEnvelopeV1 {
  readonly schemaVersion: 'feeding-operation-envelope/v1';
  readonly observedAt: string;
  readonly catalogDigest: string;
  readonly commandDigest: string;
  readonly authorityGeneration: number;
  readonly lockSetDigest: string;
}

export interface FeedingOperationEnvelopeArtifactV1 {
  readonly envelope: FeedingOperationEnvelopeV1;
  readonly canonicalJson: string;
  readonly digest: string;
}

export interface FeedingOperationLockScopeV1 {
  readonly tenantId: string;
  readonly jobId: FeedingJobId;
  readonly targetKind: 'tenant' | 'site' | 'unit';
  readonly targetId: string | null;
  readonly localDate: string;
}

function digest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalInstant(value: Date | string): string {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(instant.getTime()))
    throw new TypeError('observedAt must be a valid instant');
  const iso = instant.toISOString();
  if (typeof value === 'string' && value !== iso) {
    throw new TypeError('observedAt must be canonical UTC ISO-8601');
  }
  return iso;
}

function canonicalUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError(`${name} must be a canonical lowercase RFC 4122 UUID`);
  }
  return value;
}

function canonicalLocalDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('localDate must be a canonical ISO calendar date');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError('localDate must be a real ISO calendar date');
  }
  return value;
}

export function compileFeedingOperationLockSetDigestV1(scope: FeedingOperationLockScopeV1): string {
  canonicalUuid(scope.tenantId, 'tenantId');
  canonicalLocalDate(scope.localDate);
  if (scope.targetKind === 'tenant' && scope.targetId !== null) {
    throw new TypeError('Tenant feeding operation lock scope cannot carry a target id');
  }
  if (scope.targetKind !== 'tenant') {
    if (scope.targetId === null) {
      throw new TypeError('Site/unit feeding operation lock scope requires a target id');
    }
    canonicalUuid(scope.targetId, 'targetId');
  }
  return canonicalJsonSha256(
    {
      domain: 'aquaculture.feeding-operation-lock-set',
      schemaVersion: 'feeding-operation-lock-set/v1',
    },
    createCanonicalJsonDocumentV1(scope),
  );
}

export function compileFeedingOperationEnvelopeV1(input: {
  readonly observedAt: Date | string;
  readonly catalogDigest: string;
  readonly commandDigest: string;
  readonly authorityGeneration: number;
  readonly lockSetDigest: string;
}): FeedingOperationEnvelopeArtifactV1 {
  if (!Number.isSafeInteger(input.authorityGeneration) || input.authorityGeneration < 1) {
    throw new TypeError('authorityGeneration must be a positive safe integer');
  }
  const envelope: FeedingOperationEnvelopeV1 = freezeAuthorityGraphV1({
    schemaVersion: FEEDING_OPERATION_ENVELOPE_HASH_AUTHORITY_V1.schemaVersion,
    observedAt: canonicalInstant(input.observedAt),
    catalogDigest: digest(input.catalogDigest, 'catalogDigest'),
    commandDigest: digest(input.commandDigest, 'commandDigest'),
    authorityGeneration: input.authorityGeneration,
    lockSetDigest: digest(input.lockSetDigest, 'lockSetDigest'),
  });
  const document = createCanonicalJsonDocumentV1(envelope);
  return freezeAuthorityGraphV1({
    envelope,
    canonicalJson: canonicalJsonStringify(document),
    digest: canonicalJsonSha256(FEEDING_OPERATION_ENVELOPE_HASH_AUTHORITY_V1, document),
  });
}

export function feedingOperationObservedAtV1(envelope: FeedingOperationEnvelopeV1): Date {
  return new Date(envelope.observedAt);
}
