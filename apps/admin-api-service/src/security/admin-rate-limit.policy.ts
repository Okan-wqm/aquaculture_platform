import type {
  RateLimitEdgeConfig,
  RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';

/**
 * Admin API rate-limit policy SSoT. All controllers, the pre-auth JWT boundary,
 * and the impersonation domain service reference these immutable definitions.
 */
export const ADMIN_RATE_LIMIT_POLICIES = Object.freeze({
  default: {
    name: 'admin-default',
    limit: 500,
    windowMs: 60_000,
    requiresDistributedStore: true,
  },
  anonymous: {
    name: 'admin-anonymous',
    limit: 20,
    windowMs: 60_000,
    requiresDistributedStore: true,
  },
  tenant: {
    name: 'admin-tenant',
    limit: 500,
    windowMs: 60_000,
    requiresDistributedStore: true,
  },
  mutation: {
    name: 'admin-mutation',
    limit: 60,
    windowMs: 60_000,
    requiresDistributedStore: true,
  },
  sensitive: {
    name: 'admin-sensitive',
    limit: 3,
    windowMs: 5 * 60_000,
    requiresDistributedStore: true,
  },
  export: {
    name: 'admin-export',
    limit: 5,
    windowMs: 60 * 60_000,
    requiresDistributedStore: true,
  },
  passwordReset: {
    name: 'admin-password-reset',
    limit: 3,
    windowMs: 60 * 60_000,
    requiresDistributedStore: true,
  },
  failedAuth: {
    name: 'admin-failed-auth',
    limit: 20,
    windowMs: 15 * 60_000,
    requiresDistributedStore: true,
  },
  impersonationStart: {
    name: 'admin-impersonation-start',
    limit: 5,
    windowMs: 5 * 60_000,
    requiresDistributedStore: true,
    identifier: ({ userId, ip }) => (userId ? `${userId}:${ip ?? 'unknown'}` : undefined),
  },
} satisfies Record<string, RateLimitRouteConfig>);

/**
 * Application-wide policy: every request receives an identity tier and every
 * HTTP mutation receives an additional mutation tier. Decorators are additive,
 * so neither class-level nor method-level metadata can replace these budgets.
 */
export const ADMIN_RATE_LIMIT_EDGE_CONFIG: RateLimitEdgeConfig = Object.freeze({
  tiers: {
    default: ADMIN_RATE_LIMIT_POLICIES.default,
    anonymous: ADMIN_RATE_LIMIT_POLICIES.anonymous,
    tenant: ADMIN_RATE_LIMIT_POLICIES.tenant,
    mutation: ADMIN_RATE_LIMIT_POLICIES.mutation,
  },
  endpointBuckets: [],
  httpMutationTier: 'mutation',
  exemptions: [
    {
      methods: ['GET'] as const,
      paths: [
        '/health',
        '/health/live',
        '/health/ready',
        '/health/startup',
        '/v1/health',
        '/v1/health/live',
        '/v1/health/ready',
        '/v1/health/startup',
      ],
    },
  ],
});
