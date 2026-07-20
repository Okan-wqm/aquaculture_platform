import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ServiceIdentityKeyringEntry } from '../utils/service-identity.util';

export const FEATURE_EVALUATION_SNAPSHOT_VERSION = 'v1' as const;
export const FEATURE_EVALUATION_ISSUER = 'admin-api-service' as const;
export const FEATURE_EVALUATION_MAX_LIFETIME_MS = 30_000;
export const FEATURE_EVALUATION_MAX_FUTURE_SKEW_MS = 5_000;

const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export interface FeatureEvaluationValue {
  readonly key: string;
  readonly enabled: boolean;
}

export interface FeatureEvaluationSnapshot {
  readonly version: typeof FEATURE_EVALUATION_SNAPSHOT_VERSION;
  readonly issuer: typeof FEATURE_EVALUATION_ISSUER;
  readonly audience: string;
  readonly tenantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evaluations: readonly FeatureEvaluationValue[];
  readonly keyId: string;
  readonly signature: string;
}

export class FeatureEvaluationSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeatureEvaluationSnapshotError.name;
  }
}

export interface SignFeatureEvaluationSnapshotOptions {
  readonly audience: string;
  readonly tenantId: string;
  readonly evaluations: readonly FeatureEvaluationValue[];
  readonly keyring: readonly ServiceIdentityKeyringEntry[];
  readonly activeKeyId: string;
  readonly nowMs?: number;
  readonly lifetimeMs?: number;
}

export interface VerifyFeatureEvaluationSnapshotOptions {
  readonly keyring: readonly ServiceIdentityKeyringEntry[];
  readonly expectedAudience: string;
  readonly expectedTenantId: string;
  readonly expectedFeatureKeys: readonly string[];
  readonly nowMs?: number;
}

/**
 * Sign the authoritative admin-api feature evaluation returned to one caller.
 * The fixed-order JSON tuple is collision-safe and deliberately excludes all
 * explanatory/admin fields: consumers receive booleans, never rollout policy.
 */
export function signFeatureEvaluationSnapshot(
  options: SignFeatureEvaluationSnapshotOptions,
): FeatureEvaluationSnapshot {
  assertAudience(options.audience);
  assertTenantId(options.tenantId);

  const evaluations = normalizeEvaluations(options.evaluations);
  const key = options.keyring.find((entry) => entry.kid === options.activeKeyId);
  if (!key || key.status !== 'active') {
    throw new FeatureEvaluationSnapshotError(
      'Feature evaluation signing key must resolve to an active keyring entry',
    );
  }
  assertKeyMaterial(key);

  const nowMs = options.nowMs ?? Date.now();
  const lifetimeMs = options.lifetimeMs ?? FEATURE_EVALUATION_MAX_LIFETIME_MS;
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation signing time is invalid');
  }
  if (
    !Number.isInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > FEATURE_EVALUATION_MAX_LIFETIME_MS
  ) {
    throw new FeatureEvaluationSnapshotError(
      `Feature evaluation lifetime must be between 1 and ${FEATURE_EVALUATION_MAX_LIFETIME_MS} ms`,
    );
  }

  const unsigned = {
    version: FEATURE_EVALUATION_SNAPSHOT_VERSION,
    issuer: FEATURE_EVALUATION_ISSUER,
    audience: options.audience,
    tenantId: options.tenantId,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
    evaluations,
    keyId: key.kid,
  } as const;

  return {
    ...unsigned,
    signature: createHmac('sha256', key.secret).update(canonicalSnapshot(unsigned)).digest('hex'),
  };
}

/**
 * Strictly validate and authenticate a snapshot. Every structural, temporal,
 * tenant, audience, key-status, and requested-key mismatch is a hard error so
 * callers can collapse the outcome to disabled without accepting stale data.
 */
export function verifyFeatureEvaluationSnapshot(
  value: unknown,
  options: VerifyFeatureEvaluationSnapshotOptions,
): FeatureEvaluationSnapshot {
  assertAudience(options.expectedAudience);
  assertTenantId(options.expectedTenantId);
  const expectedKeys = normalizeFeatureKeys(options.expectedFeatureKeys);
  const snapshot = parseSnapshot(value);

  if (snapshot.audience !== options.expectedAudience) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation audience mismatch');
  }
  if (snapshot.tenantId !== options.expectedTenantId) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation tenant mismatch');
  }

  const actualKeys = snapshot.evaluations.map((evaluation) => evaluation.key);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation key set mismatch');
  }

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation verification time is invalid');
  }
  const issuedAtMs = Date.parse(snapshot.issuedAt);
  const expiresAtMs = Date.parse(snapshot.expiresAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    new Date(issuedAtMs).toISOString() !== snapshot.issuedAt ||
    new Date(expiresAtMs).toISOString() !== snapshot.expiresAt
  ) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation timestamps are invalid');
  }
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > FEATURE_EVALUATION_MAX_LIFETIME_MS) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation lifetime is invalid');
  }
  if (issuedAtMs > nowMs + FEATURE_EVALUATION_MAX_FUTURE_SKEW_MS) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation was issued in the future');
  }
  if (expiresAtMs <= nowMs) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation has expired');
  }

  const key = options.keyring.find((entry) => entry.kid === snapshot.keyId);
  if (!key || (key.status !== 'active' && key.status !== 'previous')) {
    throw new FeatureEvaluationSnapshotError(
      'Feature evaluation verification key is not active or previous',
    );
  }
  assertKeyMaterial(key);

  const expectedSignature = createHmac('sha256', key.secret)
    .update(canonicalSnapshot(snapshot))
    .digest('hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const observedBuffer = Buffer.from(snapshot.signature, 'hex');
  if (
    expectedBuffer.length !== observedBuffer.length ||
    !timingSafeEqual(expectedBuffer, observedBuffer)
  ) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation signature is invalid');
  }

  return snapshot;
}

function canonicalSnapshot(snapshot: Omit<FeatureEvaluationSnapshot, 'signature'>): string {
  return JSON.stringify([
    snapshot.version,
    snapshot.issuer,
    snapshot.audience,
    snapshot.tenantId,
    snapshot.issuedAt,
    snapshot.expiresAt,
    snapshot.keyId,
    snapshot.evaluations.map((evaluation) => [evaluation.key, evaluation.enabled]),
  ]);
}

function parseSnapshot(value: unknown): FeatureEvaluationSnapshot {
  if (!isRecord(value)) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation snapshot must be an object');
  }
  assertExactKeys(value, [
    'version',
    'issuer',
    'audience',
    'tenantId',
    'issuedAt',
    'expiresAt',
    'evaluations',
    'keyId',
    'signature',
  ]);
  if (value.version !== FEATURE_EVALUATION_SNAPSHOT_VERSION) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation version is unsupported');
  }
  if (value.issuer !== FEATURE_EVALUATION_ISSUER) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation issuer is invalid');
  }
  if (typeof value.audience !== 'string') {
    throw new FeatureEvaluationSnapshotError('Feature evaluation audience is invalid');
  }
  assertAudience(value.audience);
  if (typeof value.tenantId !== 'string') {
    throw new FeatureEvaluationSnapshotError('Feature evaluation tenant is invalid');
  }
  assertTenantId(value.tenantId);
  if (typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new FeatureEvaluationSnapshotError('Feature evaluation timestamps are invalid');
  }
  if (typeof value.keyId !== 'string' || value.keyId.length < 1 || value.keyId.length > 64) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation key id is invalid');
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_PATTERN.test(value.signature)) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation signature encoding is invalid');
  }
  if (!Array.isArray(value.evaluations)) {
    throw new FeatureEvaluationSnapshotError('Feature evaluations must be an array');
  }

  const evaluations = normalizeEvaluations(value.evaluations);
  return {
    version: value.version,
    issuer: value.issuer,
    audience: value.audience,
    tenantId: value.tenantId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    evaluations,
    keyId: value.keyId,
    signature: value.signature,
  };
}

function normalizeEvaluations(values: readonly unknown[]): readonly FeatureEvaluationValue[] {
  if (values.length < 1 || values.length > 16) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation count must be between 1 and 16');
  }
  const normalized = values.map((value) => {
    if (!isRecord(value)) {
      throw new FeatureEvaluationSnapshotError('Feature evaluation entry must be an object');
    }
    assertExactKeys(value, ['key', 'enabled']);
    if (typeof value.key !== 'string' || !FEATURE_KEY_PATTERN.test(value.key)) {
      throw new FeatureEvaluationSnapshotError('Feature evaluation key is invalid');
    }
    if (typeof value.enabled !== 'boolean') {
      throw new FeatureEvaluationSnapshotError('Feature evaluation value must be boolean');
    }
    return { key: value.key, enabled: value.enabled };
  });
  const keys = normalized.map((entry) => entry.key);
  const sortedKeys = [...keys].sort();
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sortedKeys[index])) {
    throw new FeatureEvaluationSnapshotError(
      'Feature evaluations must be unique and sorted by key',
    );
  }
  return normalized;
}

function normalizeFeatureKeys(keys: readonly string[]): readonly string[] {
  return normalizeEvaluations(keys.map((key) => ({ key, enabled: false }))).map(
    (evaluation) => evaluation.key,
  );
}

function assertKeyMaterial(key: ServiceIdentityKeyringEntry): void {
  if (key.kid.length < 1 || key.kid.length > 64 || Buffer.byteLength(key.secret, 'utf8') < 32) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation key material is invalid');
  }
}

function assertAudience(audience: string): void {
  if (!SERVICE_NAME_PATTERN.test(audience)) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation audience is invalid');
  }
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation tenant is invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation snapshot has unexpected fields');
  }
}
