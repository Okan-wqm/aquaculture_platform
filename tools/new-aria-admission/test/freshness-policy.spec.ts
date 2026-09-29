import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { FreshnessPolicyDocument, loadFreshnessPolicy } from '../src/kernel/freshness-policy';

import { sha256 } from './progress-fixture';

const document = (): FreshnessPolicyDocument => ({
  schema_version: '1.0.0',
  contract_id: 'new-aria-freshness-policy-v1',
  max_clock_skew_seconds: 30,
  proof_max_age_seconds: {
    SOURCE_CODE_ORACLE: 2_592_000,
    OPERATOR_ATTESTATION: 7_776_000,
  },
  required_invalidation_keys: {
    SOURCE_CODE_ORACLE: ['authority', 'source_head'],
    OPERATOR_ATTESTATION: ['authority', 'owner'],
  },
});

describe('freshness policy', () => {
  it('loads the production policy and its exact SOURCE_CODE_ORACLE invalidators', () => {
    const bytes = readFileSync(join(__dirname, '../policy/freshness-policy.json'));
    expect(
      loadFreshnessPolicy(bytes).document.required_invalidation_keys.SOURCE_CODE_ORACLE,
    ).toEqual(['authority', 'dependency', 'policy', 'source_head', 'toolchain', 'verifier']);
  });

  it('loads a closed policy and derives its canonical digest', () => {
    const bytes = canonicalJsonBytes(document());
    const loaded = loadFreshnessPolicy(bytes);
    expect(loaded.sha256).toBe(sha256(bytes));
    expect(loaded.document.proof_max_age_seconds.SOURCE_CODE_ORACLE).toBe(2_592_000);
  });

  it.each([
    ['unknown root field', /schema/, () => ({ ...document(), extra: true })],
    ['zero clock skew', /bounds/, () => ({ ...document(), max_clock_skew_seconds: 0 })],
    [
      'empty proof map',
      /bounds/,
      () => ({
        ...document(),
        proof_max_age_seconds: {},
        required_invalidation_keys: {},
      }),
    ],
    [
      'malformed proof type',
      /proof type/,
      () => ({
        ...document(),
        proof_max_age_seconds: { lowercase: 10 },
        required_invalidation_keys: { lowercase: ['authority'] },
      }),
    ],
    [
      'missing invalidation rule',
      /bounds/,
      () => ({
        ...document(),
        required_invalidation_keys: { SOURCE_CODE_ORACLE: ['authority'] },
      }),
    ],
    [
      'duplicate invalidation key',
      /proof type/,
      () => ({
        ...document(),
        required_invalidation_keys: {
          SOURCE_CODE_ORACLE: ['authority', 'authority'],
          OPERATOR_ATTESTATION: ['authority', 'owner'],
        },
      }),
    ],
  ])('rejects %s for the named invariant', (_name, error, mutate) => {
    expect(() => loadFreshnessPolicy(canonicalJsonBytes(mutate()))).toThrow(error);
  });

  it('rejects an unsafe maximum age at the strict JSON boundary', () => {
    const unsafe = canonicalJsonBytes(document()).toString().replace('2592000', '9007199254740992');
    expect(() => loadFreshnessPolicy(Buffer.from(unsafe))).toThrow(/unsafe integer/);
  });
});
