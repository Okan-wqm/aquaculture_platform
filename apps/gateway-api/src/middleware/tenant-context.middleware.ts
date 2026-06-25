/**
 * Tenant Context Middleware
 *
 * Establishes tenant context for multi-tenant requests.
 * Resolves tenant from various sources and loads tenant metadata.
 * Provides tenant-aware configuration and settings.
 */

import { AsyncLocalStorage } from 'async_hooks';

import { Injectable, NestMiddleware, Logger, BadRequestException, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TenantStatus,
  isLoginAllowed,
  TenantPlan,
  toTenantPlan,
  resolvePlanLimits,
} from '@platform/event-contracts';
import { Request, Response, NextFunction } from 'express';

import { TenantLookupService } from '../services/tenant-lookup.service';

// Canonical tenant lifecycle status (MT-HIGH-003). Pre-fix the gateway owned a
// LOWERCASE drift copy (active/suspended/pending/trial/expired) — its TRIAL and
// EXPIRED values are not lifecycle states at all (TRIAL is a plan; expiry is a
// billing concern) and never matched the UPPERCASE values auth persists, so the
// tenant-lookup `mapStatus` shim had to lowercase-normalise on every read.
// Re-export the canonical so downstream gateway code keeps importing
// TenantStatus from this middleware.
export { TenantStatus } from '@platform/event-contracts';

/**
 * Tenant metadata
 */
export interface TenantMetadata {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  settings: TenantSettings;
  features: TenantFeatures;
  limits: TenantLimits;
  branding?: TenantBranding;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant settings
 */
export interface TenantSettings {
  timezone: string;
  locale: string;
  dateFormat: string;
  currency: string;
  defaultUnits: 'metric' | 'imperial';
  notifications: {
    email: boolean;
    sms: boolean;
    push: boolean;
  };
}

/**
 * Tenant features
 */
export interface TenantFeatures {
  advancedAnalytics: boolean;
  alertEngine: boolean;
  iotIntegration: boolean;
  apiAccess: boolean;
  customReports: boolean;
  multiSite: boolean;
  whiteLabeling: boolean;
  ssoEnabled: boolean;
}

/**
 * Tenant limits
 */
export interface TenantLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxApiRequests: number;
  maxStorageGb: number;
  dataRetentionDays: number;
}

/**
 * Tenant branding
 */
export interface TenantBranding {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  faviconUrl?: string;
  customDomain?: string;
}

/**
 * Extended request with tenant context
 */
export interface TenantContextRequest extends Request {
  tenant?: TenantMetadata;
  tenantId?: string;
}

/**
 * Tenant context storage
 */
export const tenantStorage = new AsyncLocalStorage<TenantMetadata>();

/**
 * Default tenant settings
 */
const DEFAULT_SETTINGS: TenantSettings = {
  timezone: 'UTC',
  locale: 'en-US',
  dateFormat: 'YYYY-MM-DD',
  currency: 'USD',
  defaultUnits: 'metric',
  notifications: {
    email: true,
    sms: false,
    push: true,
  },
};

/**
 * Default tenant features by plan
 */
const PLAN_FEATURES: Record<string, TenantFeatures> = {
  free: {
    advancedAnalytics: false,
    alertEngine: true,
    iotIntegration: false,
    apiAccess: false,
    customReports: false,
    multiSite: false,
    whiteLabeling: false,
    ssoEnabled: false,
  },
  trial: {
    advancedAnalytics: true,
    alertEngine: true,
    iotIntegration: true,
    apiAccess: true,
    customReports: false,
    multiSite: false,
    whiteLabeling: false,
    ssoEnabled: false,
  },
  starter: {
    advancedAnalytics: false,
    alertEngine: true,
    iotIntegration: true,
    apiAccess: true,
    customReports: false,
    multiSite: false,
    whiteLabeling: false,
    ssoEnabled: false,
  },
  professional: {
    advancedAnalytics: true,
    alertEngine: true,
    iotIntegration: true,
    apiAccess: true,
    customReports: true,
    multiSite: true,
    whiteLabeling: false,
    ssoEnabled: false,
  },
  enterprise: {
    advancedAnalytics: true,
    alertEngine: true,
    iotIntegration: true,
    apiAccess: true,
    customReports: true,
    multiSite: true,
    whiteLabeling: true,
    ssoEnabled: true,
  },
};

/**
 * Project the canonical PLAN_CATALOG (SSoT in @platform/event-contracts) onto
 * the gateway's `TenantLimits` shape. Replaces the former hand-copied
 * PLAN_LIMITS table — the limit numbers now live only in `plan-catalog.ts`, so
 * the gateway can never disagree with billing/admin/auth again. An unknown plan
 * string falls back to STARTER (the safest default tier).
 */
export function resolveTenantLimits(plan: string): TenantLimits {
  const limits = resolvePlanLimits(toTenantPlan(plan) ?? TenantPlan.STARTER);
  return {
    maxUsers: limits.maxUsers,
    maxFarms: limits.maxFarms,
    maxPonds: limits.maxPonds,
    maxSensors: limits.maxSensors,
    maxApiRequests: limits.maxApiRequests,
    maxStorageGb: limits.maxStorageGb,
    dataRetentionDays: limits.dataRetentionDays,
  };
}

/**
 * Tenant Context Middleware
 * Resolves and loads tenant context for requests
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);
  private readonly tenantCache = new Map<string, { tenant: TenantMetadata; expiry: number }>();
  private readonly cacheTtl: number;
  private readonly maxCacheSize: number;
  private readonly publicPaths: string[];

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(TenantLookupService) private readonly tenantLookupService?: TenantLookupService,
  ) {
    this.cacheTtl = this.configService.get<number>('TENANT_CACHE_TTL', 300000); // 5 minutes
    this.maxCacheSize = this.configService.get<number>('TENANT_CACHE_MAX_SIZE', 1000);
    // SECURITY: /graphql must be public to allow login mutation via GraphQL.
    // AuthGuard handles authentication for individual GraphQL operations.
    this.publicPaths = this.configService
      .get<string>('TENANT_PUBLIC_PATHS', '/health,/graphql,/api/v1/auth/login')
      .split(',')
      .map((p) => p.trim());
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tenantReq = req as TenantContextRequest;

    // Skip tenant resolution for public paths
    if (this.isPublicPath(req.path)) {
      return next();
    }

    try {
      // Resolve tenant ID from various sources
      const tenantId = this.resolveTenantId(req);

      // SUPER_ADMIN users operate in system scope - tenantId is optional.
      // If a tenant ID is provided (e.g. via X-Tenant-Id header for cross-tenant access),
      // resolve it normally. If not, allow the request through without tenant context.
      const user = (req as TenantContextRequest & { user?: { role?: string; roles?: string[] } }).user;
      const isSuperAdmin =
        user?.roles?.includes('SUPER_ADMIN') || user?.role === 'SUPER_ADMIN';

      if (!tenantId && isSuperAdmin) {
        tenantReq.tenantId = undefined;
        return next();
      }

      if (!tenantId) {
        throw new BadRequestException({
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant could not be resolved from request',
        });
      }

      // Load tenant metadata (async for production database lookup)
      const tenant = await this.loadTenant(tenantId);

      if (!tenant) {
        throw new BadRequestException({
          code: 'TENANT_NOT_FOUND',
          message: `Tenant not found: ${tenantId}`,
        });
      }

      // Tenant status gate (MT-HIGH-003, defense-in-depth). A token is only
      // minted for an ACTIVE tenant's users (auth login's isLoginAllowed
      // allow-list), so a non-ACTIVE tenant reaching the gateway means the
      // tenant changed state after the token was issued. Fail closed: block
      // every non-ACTIVE status. SUSPENDED keeps its specific code for the
      // common payment/policy case; the dead EXPIRED branch is removed —
      // EXPIRED was never a lifecycle status (auth never persisted it; the
      // canonical machine has no such state) and the old check could never fire.
      if (tenant.status === TenantStatus.SUSPENDED) {
        throw new BadRequestException({
          code: 'TENANT_SUSPENDED',
          message: 'Tenant account is suspended',
        });
      }

      if (!isLoginAllowed(tenant.status)) {
        throw new BadRequestException({
          code: 'TENANT_NOT_ACTIVE',
          message: 'Tenant account is not active',
        });
      }

      // Attach tenant to request
      tenantReq.tenant = tenant;
      tenantReq.tenantId = tenant.id;

      // Set response headers
      // SECURITY: Sanitize tenant name to prevent CRLF header injection
      res.setHeader('X-Tenant-ID', tenant.id);
      res.setHeader('X-Tenant-Name', tenant.name.replace(/[\r\n]/g, ''));

      // Run next middleware within tenant context
      tenantStorage.run(tenant, () => {
        next();
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error('Tenant resolution failed', {
        error: (error as Error).message,
        path: req.path,
      });

      throw new BadRequestException({
        code: 'TENANT_RESOLUTION_FAILED',
        message: 'Failed to resolve tenant context',
      });
    }
  }

  /**
   * Resolve tenant ID from request
   *
   * SECURITY: For authenticated requests, the JWT tenantId claim is the
   * authoritative source. The X-Tenant-ID header is only used as a hint
   * for unauthenticated/pre-auth paths where no JWT is present. This
   * prevents tenant spoofing via header manipulation.
   */
  private resolveTenantId(req: Request): string | undefined {
    // SECURITY: Validate UUID format to prevent injection attacks via crafted tenant IDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    // Priority 1: JWT claim (if authenticated) - TRUSTED, non-spoofable source
    const user = (req as TenantContextRequest & { user?: { tenantId?: string } }).user;
    if (user?.tenantId) {
      // Log if header disagrees with JWT for observability
      const headerTenantId = req.headers['x-tenant-id'] as string;
      if (headerTenantId && headerTenantId !== user.tenantId) {
        this.logger.warn('X-Tenant-ID header mismatch with JWT claim', {
          headerTenantId,
          jwtTenantId: user.tenantId,
          path: req.path,
        });
      }
      return user.tenantId;
    }

    // Priority 2: X-Tenant-ID header (only for unauthenticated/pre-auth requests)
    const headerTenantId = req.headers['x-tenant-id'] as string;
    if (headerTenantId) {
      if (!uuidRegex.test(headerTenantId)) {
        this.logger.warn(`Invalid X-Tenant-ID header format rejected: ${headerTenantId.substring(0, 40)}`);
        return undefined;
      }
      return headerTenantId;
    }

    // Priority 3: Subdomain -- not a UUID, so skip UUID validation (slug-based)
    const host = req.headers['host'] || '';
    const subdomain = this.extractSubdomain(host);
    if (subdomain && !['www', 'api', 'app'].includes(subdomain)) {
      return subdomain;
    }

    // Priority 4: Path parameter
    const pathMatch = req.path.match(/^\/tenants\/([^/]+)/);
    if (pathMatch?.[1]) {
      if (!uuidRegex.test(pathMatch[1])) {
        this.logger.warn(`Invalid tenant ID in path rejected: ${pathMatch[1].substring(0, 40)}`);
        return undefined;
      }
      return pathMatch[1];
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
   * Load tenant metadata
   * Delegates to TenantLookupService which manages its own bounded cache
   * to avoid storing tenant metadata twice in-process.
   */
  private async loadTenant(tenantId: string): Promise<TenantMetadata | null> {
    const isProduction = process.env['NODE_ENV'] === 'production';

    // Production: Delegate entirely to TenantLookupService (which has its own bounded cache)
    // SECURITY: Fail closed — if TenantLookupService is missing in production, throw
    // instead of returning null. Returning null would silently bypass tenant resolution.
    if (isProduction) {
      if (!this.tenantLookupService) {
        throw new Error(
          'CRITICAL: TenantLookupService is not registered in production. ' +
          'Register TenantLookupService in the gateway AppModule providers.',
        );
      }

      return this.tenantLookupService.lookupTenant(tenantId);
    }

    // Development only: use local cache for mock tenants
    const cached = this.tenantCache.get(tenantId);
    if (cached && cached.expiry > Date.now()) {
      return cached.tenant;
    }

    // Development only: create mock tenant based on ID
    const tenant = this.createMockTenant(tenantId);

    if (tenant) {
      this.tenantCache.set(tenantId, {
        tenant,
        expiry: Date.now() + this.cacheTtl,
      });
      this.enforceCacheSizeLimit();
    }

    return tenant;
  }

  /**
   * SECURITY: Enforce cache size limit to prevent unbounded memory growth.
   * An attacker could exhaust gateway heap by sending requests with distinct random UUIDs.
   */
  private enforceCacheSizeLimit(): void {
    if (this.tenantCache.size <= this.maxCacheSize) {
      return;
    }
    // Remove expired entries first
    const now = Date.now();
    for (const [key, value] of this.tenantCache) {
      if (value.expiry < now) {
        this.tenantCache.delete(key);
      }
    }
    // If still over limit, remove oldest entries
    if (this.tenantCache.size > this.maxCacheSize) {
      const entries = Array.from(this.tenantCache.entries())
        .sort((a, b) => a[1].expiry - b[1].expiry);
      const toRemove = entries.slice(0, entries.length - this.maxCacheSize);
      for (const [key] of toRemove) {
        this.tenantCache.delete(key);
      }
      this.logger.debug(`Tenant cache size limit enforced: removed ${toRemove.length} entries`);
    }
  }

  /**
   * Create mock tenant for development only
   * SECURITY: Must never be called in production
   */
  private createMockTenant(tenantId: string): TenantMetadata {
    const plan = 'professional'; // Default plan
    const planFeatures = PLAN_FEATURES[plan] as TenantFeatures;
    const planLimits = resolveTenantLimits(plan);

    return {
      id: tenantId,
      name: `Tenant ${tenantId}`,
      slug: tenantId.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      status: TenantStatus.ACTIVE,
      plan,
      settings: { ...DEFAULT_SETTINGS },
      features: { ...planFeatures },
      limits: { ...planLimits },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Check if path is public
   */
  private isPublicPath(path: string): boolean {
    return this.publicPaths.some((p) => path.startsWith(p));
  }

  /**
   * Invalidate tenant cache
   */
  invalidateCache(tenantId: string): void {
    this.tenantCache.delete(tenantId);
  }

  /**
   * Clear all tenant cache
   */
  clearCache(): void {
    this.tenantCache.clear();
  }
}

/**
 * Get current tenant from async local storage
 */
export function getCurrentTenant(): TenantMetadata | undefined {
  return tenantStorage.getStore();
}

/**
 * Get current tenant ID
 */
export function getCurrentTenantId(): string | undefined {
  return getCurrentTenant()?.id;
}

/**
 * Get tenant from request
 */
export function getTenantFromRequest(req: Request): TenantMetadata | undefined {
  return (req as TenantContextRequest).tenant;
}

/**
 * Check if tenant has feature
 */
export function tenantHasFeature(feature: keyof TenantFeatures): boolean {
  const tenant = getCurrentTenant();
  return tenant?.features[feature] ?? false;
}

/**
 * Get tenant limit
 */
export function getTenantLimit(limit: keyof TenantLimits): number {
  const tenant = getCurrentTenant();
  return tenant?.limits[limit] ?? 0;
}

/**
 * Get tenant setting
 */
export function getTenantSetting<K extends keyof TenantSettings>(
  setting: K,
): TenantSettings[K] | undefined {
  const tenant = getCurrentTenant();
  return tenant?.settings[setting];
}

/**
 * Run function within tenant context
 */
export function runInTenantContext<T>(tenant: TenantMetadata, fn: () => T): T {
  return tenantStorage.run(tenant, fn);
}
