/**
 * Tenant Context Interceptor
 *
 * Extracts and propagates tenant context throughout the request lifecycle.
 * Ensures tenant isolation and provides tenant-aware request processing.
 * Integrates with AsyncLocalStorage for context propagation.
 */

import { AsyncLocalStorage } from 'async_hooks';

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap, finalize } from 'rxjs/operators';

/**
 * Tenant context data
 */
export interface TenantContext {
  tenantId: string;
  tenantName?: string;
  tenantSlug?: string;
  subscriptionTier?: string;
  isActive: boolean;
  features?: TenantFeatures;
  limits?: TenantLimits;
  metadata?: Record<string, unknown>;
}

/**
 * Tenant feature flags
 */
export interface TenantFeatures {
  alertsEnabled?: boolean;
  reportsEnabled?: boolean;
  apiAccessEnabled?: boolean;
  customIntegrationsEnabled?: boolean;
  advancedAnalyticsEnabled?: boolean;
  multiSiteEnabled?: boolean;
  iotIntegrationEnabled?: boolean;
}

/**
 * Tenant resource limits
 */
export interface TenantLimits {
  maxFarms?: number;
  maxPonds?: number;
  maxSensors?: number;
  maxUsers?: number;
  maxApiRequestsPerHour?: number;
  dataRetentionDays?: number;
}

/**
 * Extended request with tenant context
 */
export interface TenantAwareRequest extends Request {
  tenantContext?: TenantContext;
  tenantId?: string;
}

/**
 * User payload from JWT
 */
interface UserPayload {
  sub: string;
  tenantId?: string;
  tenant_id?: string;
  organizationId?: string;
  roles?: string[];
  permissions?: string[];
}

/**
 * AsyncLocalStorage instance for tenant context
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Tenant Context Interceptor
 * Manages tenant context throughout request lifecycle
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantContextInterceptor.name);
  private readonly tenantHeader = 'x-tenant-id';
  private readonly tenantCache = new Map<string, { context: TenantContext; expiry: number }>();
  private readonly cacheTtl = 5 * 60 * 1000; // 5 minutes

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contextType = context.getType<string>();
    const isGraphQL = contextType === 'graphql';

    let request: TenantAwareRequest;
    let response: Response | undefined;

    if (isGraphQL) {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext<{ req: TenantAwareRequest; res?: Response }>();
      request = ctx.req;
      response = ctx.res;
    } else {
      request = context.switchToHttp().getRequest<TenantAwareRequest>();
      response = context.switchToHttp().getResponse<Response>();
    }

    // Extract tenant ID from various sources
    const tenantId = this.extractTenantId(request);

    if (!tenantId) {
      // Allow public endpoints without tenant context
      if (this.isPublicEndpoint(request)) {
        return next.handle();
      }

      this.logger.warn('No tenant ID found in request', {
        path: request.path,
        method: request.method,
      });

      throw new UnauthorizedException('Tenant context is required');
    }

    // Get or create tenant context
    const tenantContext = this.getTenantContext(tenantId, request);

    // Attach to request
    request.tenantContext = tenantContext;
    request.tenantId = tenantId;

    // Set response header
    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-Tenant-ID', tenantId);
    }

    // Run handler within AsyncLocalStorage context
    return new Observable((subscriber) => {
      tenantContextStorage.run(tenantContext, () => {
        const startTime = Date.now();

        next
          .handle()
          .pipe(
            tap(() => {
              const duration = Date.now() - startTime;
              this.logger.debug('Request completed', {
                tenantId,
                path: request.path,
                duration,
              });
            }),
            finalize(() => {
              // Cleanup if needed
            }),
          )
          .subscribe(subscriber);
      });
    });
  }

  /**
   * Extract tenant ID from request
   */
  private extractTenantId(request: TenantAwareRequest): string | undefined {
    // Priority 1: Header
    const headerTenantId = request.headers[this.tenantHeader] as string;
    if (headerTenantId) {
      return headerTenantId;
    }

    // Priority 2: JWT user payload
    const user = (request as Request & { user?: UserPayload }).user;
    if (user) {
      const jwtTenantId = user.tenantId || user.tenant_id || user.organizationId;
      if (jwtTenantId) {
        return jwtTenantId;
      }
    }

    // Priority 3: Query parameter (for specific use cases like webhooks)
    const queryTenantId = request.query['tenantId'] as string;
    if (queryTenantId) {
      return queryTenantId;
    }

    // Priority 4: Path parameter
    const pathTenantId = request.params['tenantId'];
    if (pathTenantId) {
      return pathTenantId;
    }

    // Priority 5: Subdomain extraction
    const host = request.headers['host'];
    if (host) {
      const subdomain = this.extractSubdomain(host);
      if (subdomain && subdomain !== 'www' && subdomain !== 'api') {
        return subdomain;
      }
    }

    return undefined;
  }

  /**
   * Extract subdomain from host
   */
  private extractSubdomain(host: string): string | undefined {
    const parts = host.split('.');
    if (parts.length >= 3) {
      return parts[0];
    }
    return undefined;
  }

  /**
   * Get tenant context (from cache or create new)
   */
  private getTenantContext(tenantId: string, request: TenantAwareRequest): TenantContext {
    // Check cache
    const cached = this.tenantCache.get(tenantId);
    if (cached && cached.expiry > Date.now()) {
      return cached.context;
    }

    // Create tenant context
    // In production, this would fetch from database or auth service
    const context = this.createTenantContext(tenantId, request);

    // Cache it
    this.tenantCache.set(tenantId, {
      context,
      expiry: Date.now() + this.cacheTtl,
    });

    // Cleanup old entries periodically
    this.cleanupCache();

    return context;
  }

  /**
   * Create tenant context from available data
   */
  private createTenantContext(tenantId: string, request: TenantAwareRequest): TenantContext {
    const user = (request as Request & { user?: UserPayload }).user;

    // Extract features and limits from JWT claims if available
    const jwtClaims = user as unknown as Record<string, unknown>;

    const context: TenantContext = {
      tenantId,
      isActive: true,
      features: {
        alertsEnabled: true,
        reportsEnabled: true,
        apiAccessEnabled: true,
        customIntegrationsEnabled: false,
        advancedAnalyticsEnabled: false,
        multiSiteEnabled: false,
        iotIntegrationEnabled: true,
      },
      limits: {
        maxFarms: 10,
        maxPonds: 100,
        maxSensors: 500,
        maxUsers: 50,
        maxApiRequestsPerHour: 10000,
        dataRetentionDays: 365,
      },
    };

    // Override with JWT claims if present
    if (jwtClaims) {
      if (jwtClaims['tenant_name']) {
        context.tenantName = jwtClaims['tenant_name'] as string;
      }
      if (jwtClaims['subscription_tier']) {
        context.subscriptionTier = jwtClaims['subscription_tier'] as string;
      }
      if (jwtClaims['features']) {
        context.features = {
          ...context.features,
          ...(jwtClaims['features'] as TenantFeatures),
        };
      }
      if (jwtClaims['limits']) {
        context.limits = {
          ...context.limits,
          ...(jwtClaims['limits'] as TenantLimits),
        };
      }
    }

    return context;
  }

  /**
   * Check if endpoint is public (no tenant required)
   */
  private isPublicEndpoint(request: Request): boolean {
    const publicPaths = [
      '/health',
      '/ready',
      '/live',
      '/metrics',
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
      '/api/v1/public',
    ];

    return publicPaths.some((path) => request.path.startsWith(path));
  }

  /**
   * Cleanup expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, value] of this.tenantCache.entries()) {
      if (value.expiry < now) {
        this.tenantCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned ${cleanedCount} expired tenant contexts`);
    }
  }

  /**
   * Invalidate tenant context cache
   */
  invalidateTenantCache(tenantId: string): void {
    this.tenantCache.delete(tenantId);
    this.logger.debug(`Invalidated cache for tenant: ${tenantId}`);
  }

  /**
   * Clear all tenant context cache
   */
  clearCache(): void {
    this.tenantCache.clear();
    this.logger.debug('Cleared all tenant context cache');
  }
}

/**
 * Get current tenant context from AsyncLocalStorage
 */
export function getCurrentTenantContext(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}

/**
 * Get current tenant ID
 */
export function getCurrentTenantId(): string | undefined {
  const context = getCurrentTenantContext();
  return context?.tenantId;
}

/**
 * Check if current tenant has a feature enabled
 */
export function hasTenantFeature(feature: keyof TenantFeatures): boolean {
  const context = getCurrentTenantContext();
  return context?.features?.[feature] ?? false;
}

/**
 * Get tenant limit value
 */
export function getTenantLimit(limit: keyof TenantLimits): number | undefined {
  const context = getCurrentTenantContext();
  return context?.limits?.[limit];
}

/**
 * Helper to get tenant context from request
 */
export function getTenantContextFromRequest(req: Request): TenantContext | undefined {
  return (req as TenantAwareRequest).tenantContext;
}

/**
 * Helper to get tenant ID from request
 */
export function getTenantIdFromRequest(req: Request): string | undefined {
  return (req as TenantAwareRequest).tenantId;
}

/**
 * Run a function within a specific tenant context
 */
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return tenantContextStorage.run(context, fn);
}
