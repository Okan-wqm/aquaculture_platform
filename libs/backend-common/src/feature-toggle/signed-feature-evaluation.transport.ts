import {
  signedFetch,
  type SignedFetchCircuitBreakerOption,
  type SignedFetchCircuitBreakerOptionsLike,
} from '../http/signed-http-client';

import type { FeatureEvaluationSnapshotTransport } from './fail-closed-feature-toggle.client';
import { FeatureEvaluationSnapshotError } from './feature-evaluation-snapshot';

export const FEATURE_EVALUATION_RESPONSE_MAX_BYTES = 64 * 1024;
export const FEATURE_EVALUATION_REQUEST_TIMEOUT_MAX_MS = 5_000;

export interface SignedFeatureEvaluationTransportOptions {
  readonly adminBaseUrl: string;
  readonly serviceName: 'gateway-api' | 'farm-service';
  readonly timeoutMs: number;
  readonly circuitBreaker: SignedFetchCircuitBreakerOption;
  readonly circuitBreakerOptions: SignedFetchCircuitBreakerOptionsLike;
}

/** Build the sole HMAC-v2 transport used by gateway/farm feature clients. */
export function createSignedFeatureEvaluationTransport(
  options: SignedFeatureEvaluationTransportOptions,
): FeatureEvaluationSnapshotTransport {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > FEATURE_EVALUATION_REQUEST_TIMEOUT_MAX_MS
  ) {
    throw new FeatureEvaluationSnapshotError(
      `Feature evaluation timeout must be between 1 and ${FEATURE_EVALUATION_REQUEST_TIMEOUT_MAX_MS} ms`,
    );
  }
  if (options.circuitBreakerOptions.failureMode !== 'fail-closed') {
    throw new FeatureEvaluationSnapshotError(
      'Feature evaluation transport requires a fail-closed circuit breaker',
    );
  }
  const endpoint = resolveEndpoint(options.adminBaseUrl);

  return async ({ tenantId, featureKeys }, authenticate) => {
    const body = JSON.stringify({ featureKeys });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      return await options.circuitBreaker.service.execute({
        serviceName: options.circuitBreaker.serviceName,
        tenantId,
        options: options.circuitBreakerOptions,
        fn: async () => {
          const response = await signedFetch(endpoint, {
            method: 'POST',
            serviceName: options.serviceName,
            tenantId,
            audience: 'admin-api-service',
            contentType: 'application/json',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body,
            signal: controller.signal,
            redirect: 'error',
          });
          if (!response.ok) {
            await cancelResponseBody(response);
            throw new FeatureEvaluationSnapshotError(
              'Feature evaluation authority rejected request',
            );
          }
          const mediaType = response.headers
            .get('content-type')
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase();
          if (mediaType !== 'application/json') {
            await cancelResponseBody(response);
            throw new FeatureEvaluationSnapshotError('Feature evaluation response is not JSON');
          }
          const value = await readBoundedJson(response, FEATURE_EVALUATION_RESPONSE_MAX_BYTES);
          return authenticate(value);
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function resolveEndpoint(adminBaseUrl: string): string {
  let base: URL;
  try {
    base = new URL(adminBaseUrl);
  } catch {
    throw new FeatureEvaluationSnapshotError('Admin feature evaluation URL is invalid');
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password) {
    throw new FeatureEvaluationSnapshotError('Admin feature evaluation URL is invalid');
  }
  return new URL('/api/v1/internal/feature-toggles/evaluate', base).toString();
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await cancelResponseBody(response);
      throw new FeatureEvaluationSnapshotError('Feature evaluation response exceeds byte limit');
    }
  }
  if (!response.body) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation response body is missing');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FeatureEvaluationSnapshotError('Feature evaluation response exceeds byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (declaredLength !== null && Number(declaredLength) !== bytes.byteLength) {
    throw new FeatureEvaluationSnapshotError('Feature evaluation response length mismatch');
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new FeatureEvaluationSnapshotError('Feature evaluation response JSON is malformed');
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the authoritative validation failure; cleanup is best-effort.
  }
}
