/**
 * Tenant Context Middleware
 *
 * Establishes tenant context for multi-tenant requests.
 * Resolves tenant from various sources and loads tenant metadata.
 * Provides tenant-aware configuration and settings.
 */

import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Tenant status
 */
export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  PENDING = 'pending',
  TRIAL = 'trial',
  EXPIRED = 'expired',
}

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
 * Default tenant limits by plan
 */
const PLAN_LIMITS: Record<string, TenantLimits> = {
  free: {
    maxUsers: 3,
    maxFarms: 1,
    maxPonds: 5,
    maxSensors: 10,
    maxApiRequests: 1000,
    maxStorageGb: 1,
    dataRetentionDays: 30,
  },
  starter: {
    maxUsers: 10,
    maxFarms: 3,
    maxPonds: 20,
    maxSensors: 50,
    maxApiRequests: 10000,
    maxStorageGb: 10,
    dataRetentionDays: 90,
  },
  professional: {
    maxUsers: 50,
    maxFarms: 10,
    maxPonds: 100,
    maxSensors: 500,
    maxApiRequests: 100000,
    maxStorageGb: 100,
    dataRetentionDays: 365,
  },
  enterprise: {
    maxUsers: -1, // Unlimited
    maxFarms: -1,
    maxPonds: -1,
    maxSensors: -1,
    maxApiRequests: -1,
    maxStorageGb: -1,
    dataRetentionDays: -1,
  },
};

/**
 * Tenant Context Middleware
 * Resolves and loads tenant context for requests
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);
  private readonly tenantCache = new Map<string, { tenant: TenantMetadata; expiry: number }>();
  private readonly cacheTtl: number;
  private readonly publicPaths: string[];

  constructor(private readonly configService: ConfigService) {
    this.cacheTtl = this.configService.get<number>('TENANT_CACHE_TTL', 300000); // 5 minutes
    this.publicPaths = this.configService
      .get<string>('TENANT_PUBLIC_PATHS', '/health,/api/v1/auth/login,/api/v1/auth/register')
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

      if (!tenantId) {
        throw new BadRequestException({
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant could not be resolved from request',
        });
      }

      // Load tenant metadata
      const tenant = await this.loadTenant(tenantId);

      if (!tenant) {
        throw new BadRequestException({
          code: 'TENANT_NOT_FOUND',
          message: `Tenant not found: ${tenantId}`,
        });
      }

      // Check tenant status
      if (tenant.status === TenantStatus.SUSPENDED) {
        throw new BadRequestException({
          code: 'TENANT_SUSPENDED',
          message: 'Tenant account is suspended',
        });
      }

      if (tenant.status === TenantStatus.EXPIRED) {
        throw new BadRequestException({
          code: 'TENANT_EXPIRED',
          message: 'Tenant subscription has expired',
        });
      }

      // Attach tenant to request
      tenantReq.tenant = tenant;
      tenantReq.tenantId = tenant.id;

      // Set response headers
      res.setHeader('X-Tenant-ID', tenant.id);
      res.setHeader('X-Tenant-Name', tenant.name);

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
   */
  private resolveTenantId(req: Request): string | undefined {
    // Priority 1: X-Tenant-ID header
    const headerTenantId = req.headers['x-tenant-id'] as string;
    if (headerTenantId) {
      return headerTenantId;
    }

    // Priority 2: JWT claim (if authenticated)
    const user = (req as TenantContextRequest & { user?: { tenantId?: string } }).user;
    if (user?.tenantId) {
      return user.tenantId;
    }

    // Priority 3: Query parameter
    const queryTenantId = req.query['tenantId'] as string;
    if (queryTenantId) {
      return queryTenantId;
    }

    // Priority 4: Subdomain
    const host = req.headers['host'] || '';
    const subdomain = this.extractSubdomain(host);
    if (subdomain && !['www', 'api', 'app'].includes(subdomain)) {
      return subdomain;
    }

    // Priority 5: Path parameter
    const pathMatch = req.path.match(/^\/tenants\/([^/]+)/);
    if (pathMatch) {
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
   */
  private async loadTenant(tenantId: string): Promise<TenantMetadata | null> {
    // Check cache
    const cached = this.tenantCache.get(tenantId);
    if (cached && cached.expiry > Date.now()) {
      return cached.tenant;
    }

    // In production, this would fetch from database
    // For now, create mock tenant based on ID
    const tenant = this.createMockTenant(tenantId);

    if (tenant) {
      this.tenantCache.set(tenantId, {
        tenant,
        expiry: Date.now() + this.cacheTtl,
      });
    }

    return tenant;
  }

  /**
   * Create mock tenant for development
   */
  private createMockTenant(tenantId: string): TenantMetadata {
    const plan = 'professional'; // Default plan
    const planFeatures = PLAN_FEATURES[plan] as TenantFeatures;
    const planLimits = PLAN_LIMITS[plan] as TenantLimits;

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
