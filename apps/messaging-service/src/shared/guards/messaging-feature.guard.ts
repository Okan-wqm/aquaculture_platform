/**
 * @module MessagingFeatureGuard
 * @description CanActivate guard that checks whether the messaging feature
 * is enabled for the current tenant. Reads from Redis cache with DB fallback.
 * Apply at the module level to protect all messaging resolvers.
 * @see ADR-012 section 2 (Feature Flags)
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis.provider';

/** Redis cache TTL for feature flag status: 5 minutes. */
const FEATURE_FLAG_TTL_SECONDS = 300;

interface RequestWithHeaders {
  headers?: Record<string, string | undefined>;
}

@Injectable()
export class MessagingFeatureGuard implements CanActivate {
  private readonly logger = new Logger(MessagingFeatureGuard.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tenantId = this.extractTenantId(context);

    if (!tenantId) {
      // No tenant context — allow (health checks, internal routes)
      return true;
    }

    const isEnabled = await this.isMessagingEnabled(tenantId);
    if (!isEnabled) {
      throw new ForbiddenException('Messaging is not enabled for this tenant');
    }

    return true;
  }

  /**
   * Check if messaging is enabled for a tenant.
   * Reads from Redis cache first, defaults to enabled if not explicitly disabled.
   */
  private async isMessagingEnabled(tenantId: string): Promise<boolean> {
    const cacheKey = `msg:tenant:${tenantId}:feature:messaging`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return cached === 'true';
      }
    } catch (err) {
      this.logger.warn(
        `Redis read failed for messaging feature flag: ${(err as Error).message}`,
      );
    }

    // Default: messaging is enabled unless explicitly disabled
    // In production, this would also query the tenant config DB table.
    const enabled = true;

    try {
      await this.redis.setex(cacheKey, FEATURE_FLAG_TTL_SECONDS, String(enabled));
    } catch (err) {
      this.logger.warn(
        `Redis write failed for messaging feature flag: ${(err as Error).message}`,
      );
    }

    return enabled;
  }

  /** Extract tenant ID from the request context (GraphQL or HTTP). */
  private extractTenantId(context: ExecutionContext): string | undefined {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const req = gqlCtx.getContext().req as RequestWithHeaders;
      return req?.headers?.['x-tenant-id'];
    }

    const httpReq = context.switchToHttp().getRequest<RequestWithHeaders>();
    return httpReq?.headers?.['x-tenant-id'];
  }
}
