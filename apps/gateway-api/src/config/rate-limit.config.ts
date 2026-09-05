import { RateLimitEdgeConfig } from '@aquaculture/backend-common/rate-limit';
import { ConfigService } from '@nestjs/config';

/**
 * Gateway edge rate-limit policy (D2 / CRITICAL-002).
 *
 * The gateway is a GraphQL/HTTP edge proxy with no decorated handler routes, so
 * it cannot use the shared lib's @RateLimit decorator model. Instead it supplies
 * a config-driven RateLimitEdgeConfig to RateLimitModule.forRoot({ edge }); the
 * shared RateLimitGuard then classifies each request into a named tier and
 * counts it through the SAME atomic Lua store every other service uses.
 *
 * This reproduces the gateway guard's ENFORCED tiers
 * (login / upload / tenant / anonymous / default), the costly marine-render
 * route, and the previously-separate in-memory MutationRateLimitGuard cap
 * (`mutations`) — all counted through the distributed store.
 *
 * NOTE — passwordReset: the old rate-limit.config.ts also DECLARED a
 * passwordReset tier, but the gateway guard NEVER enforced it (it had no
 * reset-path classification). auth-service owns reset throttling via
 * @RateLimit('password-reset', 3 / 1h). Wiring it here would newly limit a path
 * the gateway never limited — a behavior change deliberately out of D2's scope.
 */
function num(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string | number | undefined>(key);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  if (typeof raw === 'string' && !/^\d+$/u.test(raw)) {
    return fallback;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildGatewayEdgeConfig(config: ConfigService): RateLimitEdgeConfig {
  const windowMs = num(config, 'RATE_LIMIT_WINDOW_MS', 60_000);
  return {
    tiers: {
      default: { name: 'default', limit: num(config, 'RATE_LIMIT_DEFAULT', 100), windowMs },
      anonymous: { name: 'anonymous', limit: num(config, 'RATE_LIMIT_ANONYMOUS', 20), windowMs },
      tenant: { name: 'tenant', limit: num(config, 'RATE_LIMIT_TENANT', 1000), windowMs },
      login: {
        name: 'login',
        limit: num(config, 'RATE_LIMIT_LOGIN_MAX', 5),
        windowMs: num(config, 'RATE_LIMIT_LOGIN_WINDOW_MS', 900_000),
      },
      upload: {
        name: 'upload',
        limit: num(config, 'RATE_LIMIT_UPLOAD_MAX', 10),
        windowMs: num(config, 'RATE_LIMIT_UPLOAD_WINDOW_MS', 60_000),
      },
      marineRender: {
        name: 'marine-render',
        limit: num(config, 'RATE_LIMIT_MARINE_RENDER_MAX', 6),
        windowMs: num(config, 'RATE_LIMIT_MARINE_RENDER_WINDOW_MS', 60_000),
      },
      mutations: {
        name: 'mutations',
        limit: num(config, 'RATE_LIMIT_MUTATION_MAX', 30),
        windowMs: num(config, 'RATE_LIMIT_MUTATION_WINDOW_MS', 60_000),
      },
    },
    endpointBuckets: [
      // Exact-match (SECREV-LOW-001): substring/suffix paths do NOT share these.
      // Every entry must name something the gateway actually serves —
      // tests/invariants/gateway-rate-limit-buckets-resolve.spec.ts derives the
      // registered routes from the controllers and the mutation fields from the
      // auth-service resolvers. Until 2026-09-05 the login tier was keyed on
      // `/api/auth/login`, a REST path no service registers, while login is the
      // GraphQL `login` mutation: brute-force protection never engaged
      // (SEC-HIGH-061). The upload paths named `/api/files/upload`, which the
      // gateway does not serve either.
      {
        tier: 'login',
        paths: [],
        graphqlMutations: ['login', 'verifyMfaLogin', 'verifyWebAuthnLogin'],
      },
      {
        tier: 'upload',
        paths: ['/api/v1/upload/chemical-document', '/api/v1/upload/batch-document'],
      },
      {
        tier: 'marineRender',
        paths: [],
        pathTemplates: ['/api/marine/sites/:siteId/render'],
      },
    ],
    mutationTier: 'mutations',
  };
}
