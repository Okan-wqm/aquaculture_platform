import { SetMetadata } from '@nestjs/common';

import { RATE_LIMIT_CONFIG_KEY, RateLimitRouteConfig } from './rate-limit.types';

/**
 * Declares a rate-limit window on a resolver/controller handler.
 *
 * The platform guard runs in explicit-config mode: handlers WITHOUT this
 * decorator are not limited by it (gateway-level identity buckets still
 * apply). That makes every limited surface visible in the code review diff
 * and testable via metadata reflection — the same pattern as @Roles().
 *
 * @example
 * @RateLimit({ name: 'login', limit: 5, windowMs: 15 * 60_000,
 *   identifier: ({ args }) => (args?.['input'] as { email?: string })?.email?.toLowerCase() })
 */
export const RateLimit = (config: RateLimitRouteConfig): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_CONFIG_KEY, config);
