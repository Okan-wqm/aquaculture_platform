export type Freshness = 'CURRENT' | 'STALE';

export interface InvalidationEpoch {
  readonly key: string;
  readonly epoch: string;
}

export interface FreshnessProof {
  readonly type: string;
  readonly observed_at: string;
  readonly valid_until: string;
  readonly invalidation_epochs: readonly InvalidationEpoch[];
}

export interface FreshnessContext {
  readonly now: string;
  readonly current_invalidation_epochs: ReadonlyMap<string, string>;
}

export interface FreshnessPolicy {
  readonly max_clock_skew_seconds: number;
  readonly proof_max_age_seconds: Readonly<Record<string, number>>;
  readonly required_invalidation_keys: Readonly<Record<string, readonly string[]>>;
}

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function timestampMs(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new TypeError(`${label} timestamp is invalid`);
  const parsed = Date.parse(value);
  if (
    !timestamp.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new TypeError(`${label} timestamp is invalid`);
  }
  return parsed;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function validateEpochs(value: unknown): asserts value is readonly InvalidationEpoch[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('freshness invalidation epochs are required');
  }
  const epochs: readonly unknown[] = value;
  const keys = new Set<string>();
  for (const item of epochs) {
    if (
      !isRecord(item) ||
      JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['epoch', 'key']) ||
      typeof item.key !== 'string' ||
      item.key.length === 0 ||
      typeof item.epoch !== 'string' ||
      item.epoch.length === 0
    ) {
      throw new TypeError('freshness invalidation key and epoch must be non-empty strings');
    }
    if (keys.has(item.key)) throw new TypeError('duplicate freshness invalidation key');
    keys.add(item.key);
  }
}

export function assertFreshnessProofShape(value: unknown): asserts value is FreshnessProof {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['invalidation_epochs', 'observed_at', 'type', 'valid_until'])
  ) {
    throw new TypeError('freshness proof schema is open or incomplete');
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new TypeError('freshness proof type is invalid');
  }
  timestampMs(value.observed_at, 'freshness observation');
  timestampMs(value.valid_until, 'freshness validity');
  validateEpochs(value.invalidation_epochs);
}

export function evaluateFreshness(
  proof: FreshnessProof,
  context: FreshnessContext,
  policy: FreshnessPolicy,
): Freshness {
  assertFreshnessProofShape(proof);
  const maxAgeSeconds = policy.proof_max_age_seconds[proof.type];
  const requiredKeys = policy.required_invalidation_keys[proof.type];
  if (maxAgeSeconds === undefined) throw new TypeError('freshness proof type is unknown');
  if (
    requiredKeys === undefined ||
    requiredKeys.length === 0 ||
    requiredKeys.some((key) => typeof key !== 'string' || key.length === 0) ||
    new Set(requiredKeys).size !== requiredKeys.length
  ) {
    throw new TypeError('freshness required invalidation policy is invalid');
  }
  const actualKeys = proof.invalidation_epochs.map(({ key }) => key).sort();
  const expectedKeys = [...requiredKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError('freshness proof does not contain the exact required invalidation keys');
  }
  positiveInteger(maxAgeSeconds, 'freshness maximum age');
  positiveInteger(policy.max_clock_skew_seconds, 'freshness clock skew');
  const observedAt = timestampMs(proof.observed_at, 'freshness observation');
  const validUntil = timestampMs(proof.valid_until, 'freshness validity');
  const now = timestampMs(context.now, 'trusted clock');
  const maximumAgeMs = maxAgeSeconds * 1000;
  if (validUntil <= observedAt || validUntil - observedAt > maximumAgeMs) {
    throw new TypeError('freshness validity exceeds maximum age');
  }
  if (observedAt - now > policy.max_clock_skew_seconds * 1000) {
    throw new TypeError('freshness observation is in the future');
  }
  if (now > validUntil || now - observedAt > maximumAgeMs) return 'STALE';
  return proof.invalidation_epochs.every(
    ({ key, epoch }) => context.current_invalidation_epochs.get(key) === epoch,
  )
    ? 'CURRENT'
    : 'STALE';
}
