import { RateLimitEndpointBucket } from '../rate-limit.types';

/*
 * Exact/segment-template endpoint → tier classification (SECREV-LOW-001 cure).
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
 * string, strip trailing slashes), then matches literal paths exactly or a
 * template one segment at a time. Forged substring/suffix/extra-segment paths
 * do NOT match. Unmatched → DEFAULT_TIER.
 */
export function classifyEndpoint(
  rawUrl: string | undefined,
  endpointBuckets: readonly RateLimitEndpointBucket[],
): string {
  const pathname = (rawUrl ?? '').split('?')[0]?.replace(/\/+$/, '') || '/';
  const canonicalPathname = pathname.toLowerCase();
  for (const bucket of endpointBuckets) {
    if (
      bucket.paths.some(
        (path) => (path.replace(/\/+$/, '') || '/').toLowerCase() === canonicalPathname,
      ) ||
      bucket.pathTemplates?.some((template) => matchesPathTemplate(pathname, template))
    ) {
      return bucket.tier;
    }
  }
  return DEFAULT_TIER;
}

function matchesPathTemplate(pathname: string, rawTemplate: string): boolean {
  const template = rawTemplate.split('?')[0]?.replace(/\/+$/, '') || '/';
  const pathSegments = pathname.split('/');
  const templateSegments = template.split('/');
  if (pathSegments.length !== templateSegments.length) {
    return false;
  }

  return templateSegments.every((templateSegment, index) => {
    const pathSegment = pathSegments[index] ?? '';
    return templateSegment.startsWith(':')
      ? templateSegment.length > 1 && pathSegment.length > 0
      : templateSegment.toLowerCase() === pathSegment.toLowerCase();
  });
}

/**
 * Classify a GraphQL operation into a tier name by exact resolver field
 * match. Only Mutation fields are bucketed: the login-class operations are
 * mutations, and a Query named like one must not inherit its cap. Unmatched
 * (or not a mutation) → DEFAULT_TIER, so the caller falls through to the
 * identity tiers exactly as for an unlisted path.
 */
export function classifyGraphqlOperation(
  parentType: string | undefined,
  fieldName: string | undefined,
  endpointBuckets: readonly RateLimitEndpointBucket[],
): string {
  if (parentType !== 'Mutation' || !fieldName) return DEFAULT_TIER;
  for (const bucket of endpointBuckets) {
    if (bucket.graphqlMutations?.includes(fieldName)) {
      return bucket.tier;
    }
  }
  return DEFAULT_TIER;
}
