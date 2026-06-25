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
import {
  TenantPlan,
  toTenantPlan,
  resolvePlanLimits,
} from '@platform/event-contracts';
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
 * May include additional claims like features and limits from tenant configuration
 */
interface UserPayload {
  sub: string;
  tenantId?: string;
  tenant_id?: string;
  organizationId?: string;
  roles?: string[];
  permissions?: string[];
  // Optional tenant configuration from JWT claims (camelCase)
  features?: TenantFeatures;
  limits?: TenantLimits;
  subscriptionTier?: string;
  tenantName?: string;
  // Snake_case variants for compatibility with different JWT issuers
  tenant_name?: string;
  subscription_tier?: string;
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
    // SECURITY (MT-CRITICAL-001 — 3rd cycle closure):
    // JWT is the cryptographically verified trust anchor. Header / param
    // fall through ONLY when JWT is absent (pre-auth, edge-ingestion,
    // HMAC-signed cross-tenant admin RPC). Query-string source REMOVED —
    // it has no cryptographic binding and can be appended by any client.
    //
    // Priority 1: JWT user payload (auth middleware decoded it).
    const user = (request as Request & { user?: UserPayload }).user;
    if (user) {
      const jwtTenantId = user.tenantId || user.tenant_id || user.organizationId;
      if (jwtTenantId) {
        return jwtTenantId;
      }
    }

    // Priority 2: x-tenant-id header — pre-auth + signed-internal RPC paths.
    const headerTenantId = request.headers[this.tenantHeader] as string;
    if (headerTenantId) {
      return headerTenantId;
    }

    // Priority 3: URL :tenantId path parameter (RESTful routes; visible
    // in route definition, audited at the controller boundary).
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
    // User payload is properly typed via UserPayload interface
    const user = (request as Request & { user?: UserPayload }).user;

    // Default limits follow the tenant's PLAN from the JWT (PLAN_CATALOG SSoT),
    // not a hardcoded table — previously this object fixed every tenant at a
    // generous "professional-ish" default that never tracked the actual tier.
    // No tier in the token → the conservative FREE tier (fail-safe, not the old
    // 500-sensor default).
    const subscriptionTier = user?.subscriptionTier ?? user?.subscription_tier;
    const planLimits = resolvePlanLimits(
      toTenantPlan(subscriptionTier) ?? TenantPlan.FREE,
    );

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
        maxFarms: planLimits.maxFarms,
        maxPonds: planLimits.maxPonds,
        maxSensors: planLimits.maxSensors,
        maxUsers: planLimits.maxUsers,
        // This surface exposes a per-HOUR budget; the canonical apiRateLimit is
        // per-minute, so scale ×60. Unlimited (-1) stays unlimited.
        maxApiRequestsPerHour:
          planLimits.apiRateLimit < 0 ? -1 : planLimits.apiRateLimit * 60,
        dataRetentionDays: planLimits.dataRetentionDays,
      },
    };

    // Override with JWT claims if present (supports both camelCase and snake_case)
    if (user) {
      // Tenant name - check both naming conventions
      const tenantName = user.tenantName ?? user.tenant_name;
      if (tenantName) {
        context.tenantName = tenantName;
      }

      // Subscription tier - check both naming conventions
      if (subscriptionTier) {
        context.subscriptionTier = subscriptionTier;
      }

      // Features from JWT
      if (user.features) {
        context.features = {
          ...context.features,
          ...user.features,
        };
      }

      // Limits from JWT
      if (user.limits) {
        context.limits = {
          ...context.limits,
          ...user.limits,
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
