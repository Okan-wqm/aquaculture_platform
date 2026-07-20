import type { ServiceIdentityKeyringEntry } from '../utils/service-identity.util';

import {
  type FeatureEvaluationSnapshot,
  FeatureEvaluationSnapshotError,
  verifyFeatureEvaluationSnapshot,
} from './feature-evaluation-snapshot';

export const FEATURE_EVALUATION_LOCAL_CACHE_MAX_TTL_MS = 10_000;
export const FEATURE_EVALUATION_DEFAULT_CACHE_TTL_MS = 5_000;
export const FEATURE_EVALUATION_FAILURE_CACHE_TTL_MS = 1_000;
export const FEATURE_EVALUATION_DEFAULT_MAX_CACHE_ENTRIES = 1_024;

const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeatureEvaluationSnapshotTransport = (
  request: {
    readonly tenantId: string;
    readonly featureKeys: readonly string[];
  },
  authenticate: (value: unknown) => unknown,
) => Promise<unknown>;

export interface FailClosedFeatureToggleClientOptions {
  readonly audience: string;
  readonly keyring: readonly ServiceIdentityKeyringEntry[];
  readonly transport: FeatureEvaluationSnapshotTransport;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  readonly onFailure?: (error: FeatureEvaluationSnapshotError) => void;
}

interface CachedEvaluation {
  readonly enabled: boolean;
  readonly expiresAtMs: number;
}

/**
 * Bounded, pod-local, signed feature evaluation cache.
 *
 * It deliberately has no Redis or stale-on-error path. A cache miss, expired
 * entry, malformed response, signature failure, timeout, or transport failure
 * becomes `false`. Concurrent identical misses share one request.
 */
export class FailClosedFeatureToggleClient {
  private readonly cache = new Map<string, CachedEvaluation>();
  private readonly inFlight = new Map<string, Promise<ReadonlyMap<string, boolean>>>();
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: FailClosedFeatureToggleClientOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? FEATURE_EVALUATION_DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? FEATURE_EVALUATION_DEFAULT_MAX_CACHE_ENTRIES;
    this.now = options.now ?? Date.now;

    if (
      !Number.isInteger(this.cacheTtlMs) ||
      this.cacheTtlMs < 1 ||
      this.cacheTtlMs > FEATURE_EVALUATION_LOCAL_CACHE_MAX_TTL_MS
    ) {
      throw new FeatureEvaluationSnapshotError(
        `Feature evaluation cache TTL must be between 1 and ${FEATURE_EVALUATION_LOCAL_CACHE_MAX_TTL_MS} ms`,
      );
    }
    if (!Number.isInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) {
      throw new FeatureEvaluationSnapshotError('Feature evaluation cache size must be positive');
    }
  }

  async isEnabled(tenantId: string, featureKey: string): Promise<boolean> {
    return (await this.evaluate(tenantId, [featureKey])).get(featureKey) ?? false;
  }

  async evaluate(
    tenantId: string,
    featureKeys: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    try {
      this.assertTenantId(tenantId);
      const keys = this.normalizeFeatureKeys(featureKeys);
      const nowMs = this.now();
      const resolved = new Map<string, boolean>();
      const missing: string[] = [];

      for (const key of keys) {
        const cacheKey = this.cacheKey(tenantId, key);
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAtMs > nowMs) {
          this.cache.delete(cacheKey);
          this.cache.set(cacheKey, cached);
          resolved.set(key, cached.enabled);
        } else {
          if (cached) this.cache.delete(cacheKey);
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        const fetched = await this.fetchMissing(tenantId, missing);
        for (const key of missing) {
          resolved.set(key, fetched.get(key) ?? false);
        }
      }

      return resolved;
    } catch (error) {
      const normalized = this.normalizeFailure(error);
      this.options.onFailure?.(normalized);
      return new Map();
    }
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async fetchMissing(
    tenantId: string,
    featureKeys: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const requestKey = `${tenantId}\u0000${featureKeys.join('\u0000')}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;

    const request = this.fetchAndVerify(tenantId, featureKeys).finally(() => {
      this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, request);
    return request;
  }

  private async fetchAndVerify(
    tenantId: string,
    featureKeys: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    try {
      const authenticate = (candidate: unknown): FeatureEvaluationSnapshot =>
        verifyFeatureEvaluationSnapshot(candidate, {
          keyring: this.options.keyring,
          expectedAudience: this.options.audience,
          expectedTenantId: tenantId,
          expectedFeatureKeys: featureKeys,
          nowMs: this.now(),
        });
      const value = await this.options.transport({ tenantId, featureKeys }, authenticate);
      const nowMs = this.now();
      const snapshot = verifyFeatureEvaluationSnapshot(value, {
        keyring: this.options.keyring,
        expectedAudience: this.options.audience,
        expectedTenantId: tenantId,
        expectedFeatureKeys: featureKeys,
        nowMs,
      });
      const signedExpiryMs = Date.parse(snapshot.expiresAt);
      const cacheExpiryMs = Math.min(signedExpiryMs, nowMs + this.cacheTtlMs);
      const result = new Map<string, boolean>();

      for (const evaluation of snapshot.evaluations) {
        result.set(evaluation.key, evaluation.enabled);
        this.setCache(this.cacheKey(tenantId, evaluation.key), {
          enabled: evaluation.enabled,
          expiresAtMs: cacheExpiryMs,
        });
      }
      return result;
    } catch (error) {
      const normalized = this.normalizeFailure(error);
      this.options.onFailure?.(normalized);
      const failureExpiryMs = this.now() + FEATURE_EVALUATION_FAILURE_CACHE_TTL_MS;
      for (const key of featureKeys) {
        this.setCache(this.cacheKey(tenantId, key), {
          enabled: false,
          expiresAtMs: failureExpiryMs,
        });
      }
      return new Map(featureKeys.map((key) => [key, false]));
    }
  }

  private setCache(key: string, value: CachedEvaluation): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private normalizeFeatureKeys(featureKeys: readonly string[]): readonly string[] {
    if (featureKeys.length < 1 || featureKeys.length > 16) {
      throw new FeatureEvaluationSnapshotError('Feature key count must be between 1 and 16');
    }
    const keys = [...featureKeys].sort();
    if (new Set(keys).size !== keys.length || keys.some((key) => !FEATURE_KEY_PATTERN.test(key))) {
      throw new FeatureEvaluationSnapshotError('Feature keys must be unique platform identifiers');
    }
    return keys;
  }

  private assertTenantId(tenantId: string): void {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new FeatureEvaluationSnapshotError('Feature evaluation tenant is invalid');
    }
  }

  private cacheKey(tenantId: string, featureKey: string): string {
    return `${tenantId}\u0000${featureKey}`;
  }

  private normalizeFailure(error: unknown): FeatureEvaluationSnapshotError {
    if (error instanceof FeatureEvaluationSnapshotError) return error;
    return new FeatureEvaluationSnapshotError('Feature evaluation failed closed');
  }
}
