import { RateLimitEndpointBucket } from '../rate-limit.types';

/*
 * Exact-match endpoint → tier classification (SECREV-LOW-001 cure).
 *
 * This is the SINGLE matcher driving BOTH the storage-key prefix and the limit
 * tier. It replaces the gateway guard's two divergent matchers (exact-match in
 * generateKey vs endsWith/includes in getRateLimitConfig), where a path like
 * `/api/v2/wrap/upload-something` got the upload LIMIT but the default KEY — a
 * latent inconsistency. Unifying on exact-match removes it.
 */

/** Tier name for any request not matching an explicit endpoint bucket. */
export const DEFAULT_TIER = 'default';

/**
 * Classify a request path into a tier name. Normalizes the URL (strip query
 * string, strip trailing slashes) then EXACT-matches against the allow-list.
 * Forged substring/suffix paths do NOT match. Unmatched → DEFAULT_TIER.
 */
export function classifyEndpoint(
  rawUrl: string | undefined,
  endpointBuckets: readonly RateLimitEndpointBucket[],
): string {
  const pathname = (rawUrl ?? '').split('?')[0]?.replace(/\/+$/, '') || '/';
  for (const bucket of endpointBuckets) {
    if (bucket.paths.includes(pathname)) {
      return bucket.tier;
    }
  }
  return DEFAULT_TIER;
}
