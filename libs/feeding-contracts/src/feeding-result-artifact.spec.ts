import { sha256Hex } from '@aquaculture/shared-contracts';

import {
  FEEDING_RESULT_HASH_DOMAIN_V1,
  FEEDING_RESULT_PORTABILITY_V1,
  compileFeedingResultArtifactV1,
  verifyFeedingResultArtifactV1,
} from './feeding-result-artifact';

const RESULT_SCHEMA = 'feeding-operation-result/v2.forecast.refresh/v1';
const FIXED_PREIMAGE =
  '{"domain":"aquaculture.feeding-operation-result-payload","schemaVersion":"feeding-operation-result-payload/v1","value":{"payload":{"a":"ok","refreshedCount":3,"z":2},"resultSchema":"feeding-operation-result/v2.forecast.refresh/v1"}}';
const FIXED_DIGEST = 'e6290539eae048f917ef84005d8b99414702b22279956bf4f9416f3b0fa43f46';

function nestedPayload(depth: number, leaf: unknown = 'portable'): unknown {
  let payload = leaf;
  for (let level = 0; level < depth; level += 1) payload = { value: payload };
  return payload;
}

describe('feeding result artifact authority', () => {
  it('emits the fixed cross-runtime canonical preimage and digest', () => {
    const artifact = compileFeedingResultArtifactV1(RESULT_SCHEMA, {
      z: 2,
      refreshedCount: 3,
      a: 'ok',
    });

    expect(artifact.payloadJson).toBe('{"a":"ok","refreshedCount":3,"z":2}');
    expect(artifact.hashPreimage).toBe(FIXED_PREIMAGE);
    expect(artifact.digest).toBe(FIXED_DIGEST);
    expect(sha256Hex(artifact.hashPreimage)).toBe(artifact.digest);
  });

  it('is byte-stable across insertion order', () => {
    const first = compileFeedingResultArtifactV1(RESULT_SCHEMA, {
      z: 2,
      refreshedCount: 3,
      a: 'ok',
    });
    const second = compileFeedingResultArtifactV1(RESULT_SCHEMA, {
      a: 'ok',
      refreshedCount: 3,
      z: 2,
    });

    expect(second).toEqual(first);
  });

  it('rejects non-canonical persisted bytes even when their JSON value is equivalent', () => {
    for (const payloadJson of [
      '{"z":2,"refreshedCount":3,"a":"ok"}',
      '{ "a": "ok", "refreshedCount": 3, "z": 2 }',
    ]) {
      expect(() =>
        verifyFeedingResultArtifactV1({
          resultSchema: RESULT_SCHEMA,
          payloadJson,
          digest: FIXED_DIGEST,
        }),
      ).toThrow(/canonical JSON/);
    }
  });

  it('binds both result schema and hash domain into the digest', () => {
    const artifact = compileFeedingResultArtifactV1(RESULT_SCHEMA, {
      a: 'ok',
      refreshedCount: 3,
      z: 2,
    });
    const otherSchema = compileFeedingResultArtifactV1(
      'feeding-operation-result/manual.day-plan.regenerate/v1',
      artifact.payload,
    );
    const otherDomainPreimage = artifact.hashPreimage.replace(
      FEEDING_RESULT_HASH_DOMAIN_V1,
      'aquaculture.feeding-operation-result-payload-test',
    );

    expect(otherSchema.digest).not.toBe(artifact.digest);
    expect(sha256Hex(otherDomainPreimage)).not.toBe(artifact.digest);
    expect(() =>
      verifyFeedingResultArtifactV1({
        resultSchema: artifact.resultSchema,
        payloadJson: artifact.payloadJson,
        digest: '0'.repeat(64),
      }),
    ).toThrow(/digest/);
  });

  it('enforces the portable SQL/JCS value vocabulary at adversarial number and key edges', () => {
    expect(
      compileFeedingResultArtifactV1(RESULT_SCHEMA, {
        zero: 0,
        minimumFraction: 0.000001,
        ordinaryFraction: -12.125,
        maximumSafeInteger: Number.MAX_SAFE_INTEGER,
        unicodeValue: 'balık 🐟',
      }).payloadJson,
    ).toBe(
      '{"maximumSafeInteger":9007199254740991,"minimumFraction":0.000001,"ordinaryFraction":-12.125,"unicodeValue":"balık 🐟","zero":0}',
    );

    for (const payload of [
      { negativeZero: -0 },
      { exponentFraction: 1e-7 },
      { exponentInteger: 1e21 },
      { unsafeInteger: Number.MAX_SAFE_INTEGER + 1 },
      { ünicodeKey: 'rejected' },
      { '🐟': 'rejected' },
    ]) {
      expect(() => compileFeedingResultArtifactV1(RESULT_SCHEMA, payload)).toThrow(
        /negative zero|non-portable|unsafe integer|object key/,
      );
    }
  });

  it('recursively rejects PostgreSQL-inexpressible NUL strings', () => {
    const nul = String.fromCharCode(0);

    for (const payload of [nul, { nested: [`before${nul}after`] }]) {
      expect(() => compileFeedingResultArtifactV1(RESULT_SCHEMA, payload)).toThrow(
        /non-portable NUL string/,
      );
    }
  });

  it('inherits recursive Unicode-scalar validation from the canonical JSON authority', () => {
    for (const invalidScalar of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      expect(() =>
        compileFeedingResultArtifactV1(RESULT_SCHEMA, {
          nested: [`before${invalidScalar}after`],
        }),
      ).toThrow(/CANONICAL_JSON_INVALID_UNICODE/);
    }
  });

  it('pins the portable payload depth boundary to the canonical JSON authority', () => {
    expect(
      compileFeedingResultArtifactV1(
        RESULT_SCHEMA,
        nestedPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth),
      ).payload,
    ).toBeDefined();
    expect(() =>
      compileFeedingResultArtifactV1(
        RESULT_SCHEMA,
        nestedPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth + 1),
      ),
    ).toThrow(/depth limit/);
  });
});
