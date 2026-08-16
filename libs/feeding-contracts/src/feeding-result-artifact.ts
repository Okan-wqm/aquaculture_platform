import {
  CANONICAL_JSON_LIMITS_V1,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
  sha256Hex,
  type CanonicalHashAuthorityV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';

export const FEEDING_RESULT_HASH_DOMAIN_V1 =
  'aquaculture.feeding-operation-result-payload' as const;
export const FEEDING_RESULT_HASH_SCHEMA_VERSION_V1 = 'feeding-operation-result-payload/v1' as const;

export const FEEDING_RESULT_HASH_AUTHORITY_V1: CanonicalHashAuthorityV1 = Object.freeze({
  domain: FEEDING_RESULT_HASH_DOMAIN_V1,
  schemaVersion: FEEDING_RESULT_HASH_SCHEMA_VERSION_V1,
});

/**
 * Closed cross-runtime vocabulary shared by the TypeScript compiler and its
 * PostgreSQL admission mirror. Migration SQL interpolates these exact values;
 * changing the subset therefore requires a new versioned authority and migration.
 */
export const FEEDING_RESULT_PORTABILITY_V1 = Object.freeze({
  forbiddenStringCodePoint: 0,
  maxPayloadBytes: 65_536,
  maxDepth: CANONICAL_JSON_LIMITS_V1.maxDepth,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
  minNonZeroNumber: 0.000_001,
  objectKeyPattern: '^[A-Za-z][A-Za-z0-9_]{0,79}$',
});

export interface FeedingResultArtifactV1 {
  readonly schemaVersion: typeof FEEDING_RESULT_HASH_SCHEMA_VERSION_V1;
  readonly resultSchema: string;
  readonly payload: CanonicalJsonValue;
  readonly payloadJson: string;
  readonly hashPreimage: string;
  readonly digest: string;
}

const RESULT_SCHEMA_PATTERN = /^feeding-operation-result\/[a-z][a-z0-9.-]{4,159}\/v1$/;
const PORTABLE_OBJECT_KEY_PATTERN = new RegExp(FEEDING_RESULT_PORTABILITY_V1.objectKeyPattern);
const PORTABLE_FORBIDDEN_NUL = String.fromCharCode(
  FEEDING_RESULT_PORTABILITY_V1.forbiddenStringCodePoint,
);

function isCanonicalJsonArray(value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value);
}

function assertNoNegativeZero(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) throw new TypeError(`${path} contains negative zero`);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertNoNegativeZero(member, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    assertNoNegativeZero(member, `${path}.${key}`, seen);
  }
}

function assertPortableResultValue(value: CanonicalJsonValue, path: string): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      throw new TypeError(`${path} contains negative zero`);
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${path} contains an unsafe integer`);
      }
      return;
    }
    const magnitude = Math.abs(value);
    if (
      magnitude < FEEDING_RESULT_PORTABILITY_V1.minNonZeroNumber ||
      magnitude > FEEDING_RESULT_PORTABILITY_V1.maxSafeInteger
    ) {
      throw new TypeError(`${path} contains a non-portable fractional number`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.includes(PORTABLE_FORBIDDEN_NUL)) {
      throw new TypeError(`${path} contains a non-portable NUL string`);
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (isCanonicalJsonArray(value)) {
    value.forEach((member, index) => assertPortableResultValue(member, `${path}[${index}]`));
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (!PORTABLE_OBJECT_KEY_PATTERN.test(key)) {
      throw new TypeError(`${path} contains a non-portable object key`);
    }
    assertPortableResultValue(member, `${path}.${key}`);
  }
}

function feedingResultHashPreimageV1(resultSchema: string, payloadJson: string): string {
  const canonicalResultSchema = canonicalJsonStringify(createCanonicalJsonDocumentV1(resultSchema));
  const canonicalDomain = canonicalJsonStringify(
    createCanonicalJsonDocumentV1(FEEDING_RESULT_HASH_AUTHORITY_V1.domain),
  );
  const canonicalSchemaVersion = canonicalJsonStringify(
    createCanonicalJsonDocumentV1(FEEDING_RESULT_HASH_AUTHORITY_V1.schemaVersion),
  );

  // `payloadJson` is already a validated canonical document. Composing the
  // fixed-key envelope from canonical fragments preserves a payload depth of
  // exactly 64; re-snapshotting it under a parent would silently reduce that
  // public boundary to 63.
  return `{"domain":${canonicalDomain},"schemaVersion":${canonicalSchemaVersion},"value":{"payload":${payloadJson},"resultSchema":${canonicalResultSchema}}}`;
}

/**
 * The sole TypeScript compiler for durable feeding-operation results.
 *
 * It snapshots the payload once, enforces the cross-runtime JSON subset whose
 * PostgreSQL normalization is byte-equivalent, emits its RFC 8785 bytes, and
 * derives the domain-separated preimage and digest from that same immutable snapshot.
 * Callers must persist the returned payloadJson and digest as one artifact;
 * independently serializing or hashing a result is not a supported contract.
 */
export function compileFeedingResultArtifactV1(
  resultSchema: string,
  payload: unknown,
): FeedingResultArtifactV1 {
  if (!RESULT_SCHEMA_PATTERN.test(resultSchema) || resultSchema.length > 200) {
    throw new TypeError('Feeding result schema is outside the closed v1 namespace');
  }
  const payloadDocument = createCanonicalJsonDocumentV1(payload, {
    maxBytes: FEEDING_RESULT_PORTABILITY_V1.maxPayloadBytes,
    maxDepth: FEEDING_RESULT_PORTABILITY_V1.maxDepth,
  });
  assertNoNegativeZero(payload, '$');
  assertPortableResultValue(payloadDocument.value, '$');
  const payloadJson = canonicalJsonStringify(payloadDocument);
  if (payloadJson.length < 2) {
    throw new TypeError('Feeding result payload is outside its byte bounds');
  }
  const hashPreimage = feedingResultHashPreimageV1(resultSchema, payloadJson);
  return Object.freeze({
    schemaVersion: FEEDING_RESULT_HASH_SCHEMA_VERSION_V1,
    resultSchema,
    payload: payloadDocument.value,
    payloadJson,
    hashPreimage,
    digest: sha256Hex(hashPreimage),
  });
}

export interface PersistedFeedingResultArtifactV1 {
  readonly resultSchema: string;
  readonly payloadJson: string;
  readonly digest: string;
}

/** Fail-closed reader for artifacts persisted by the SQL mirror authority. */
export function verifyFeedingResultArtifactV1(
  persisted: PersistedFeedingResultArtifactV1,
): FeedingResultArtifactV1 {
  let payload: unknown;
  try {
    payload = JSON.parse(persisted.payloadJson) as unknown;
  } catch {
    throw new TypeError('Persisted feeding result payload is not JSON');
  }
  const compiled = compileFeedingResultArtifactV1(persisted.resultSchema, payload);
  if (compiled.payloadJson !== persisted.payloadJson) {
    throw new TypeError('Persisted feeding result payload is not canonical JSON');
  }
  if (compiled.digest !== persisted.digest) {
    throw new TypeError('Persisted feeding result digest does not match its canonical preimage');
  }
  return compiled;
}
