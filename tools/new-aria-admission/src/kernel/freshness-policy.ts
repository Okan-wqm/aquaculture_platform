import { createHash } from 'node:crypto';

import { FreshnessPolicy } from './freshness';
import { JsonValue, parseStrictJson } from './strict-json';

export interface FreshnessPolicyDocument extends FreshnessPolicy {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-freshness-policy-v1';
}

export interface LoadedFreshnessPolicy {
  readonly document: FreshnessPolicyDocument;
  readonly sha256: string;
}

const rootKeys = [
  'schema_version',
  'contract_id',
  'max_clock_skew_seconds',
  'proof_max_age_seconds',
  'required_invalidation_keys',
];
const proofType = /^[A-Z][A-Z0-9_]*$/u;

type JsonRecord = { [key: string]: JsonValue };

const isRecord = (value: JsonValue | undefined): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const positiveInteger = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isStringArray = (value: JsonValue | undefined): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function loadFreshnessPolicy(bytes: Uint8Array): LoadedFreshnessPolicy {
  const value = parseStrictJson(bytes);
  if (!isRecord(value) || !exactKeys(value, rootKeys)) {
    throw new TypeError('freshness policy schema is open or incomplete');
  }
  const maximumAges = value.proof_max_age_seconds;
  const requiredKeys = value.required_invalidation_keys;
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-freshness-policy-v1' ||
    !positiveInteger(value.max_clock_skew_seconds) ||
    !isRecord(maximumAges) ||
    !isRecord(requiredKeys) ||
    !exactKeys(requiredKeys, Object.keys(maximumAges)) ||
    Object.keys(maximumAges).length === 0
  ) {
    throw new TypeError('freshness policy identity or bounds are invalid');
  }
  const proofMaximumAges: Record<string, number> = {};
  const proofRequiredKeys: Record<string, readonly string[]> = {};
  for (const [type, maximumAge] of Object.entries(maximumAges)) {
    const keys = requiredKeys[type];
    if (
      !proofType.test(type) ||
      !positiveInteger(maximumAge) ||
      !isStringArray(keys) ||
      keys.length === 0 ||
      keys.some((key) => !/^[a-z][a-z0-9_]*$/u.test(key)) ||
      new Set(keys).size !== keys.length ||
      keys.some((key, index) => key !== [...keys].sort()[index])
    ) {
      throw new TypeError('freshness proof type or maximum age is invalid');
    }
    proofMaximumAges[type] = maximumAge;
    proofRequiredKeys[type] = Object.freeze([...keys]);
  }
  const document: FreshnessPolicyDocument = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-freshness-policy-v1',
    max_clock_skew_seconds: value.max_clock_skew_seconds,
    proof_max_age_seconds: Object.freeze(proofMaximumAges),
    required_invalidation_keys: Object.freeze(proofRequiredKeys),
  });
  return {
    document,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
