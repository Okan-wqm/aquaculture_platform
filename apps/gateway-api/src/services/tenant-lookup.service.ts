/**
 * Tenant Lookup Service
 *
 * Provides tenant validation by querying the auth-service.
 * Used by middleware to verify tenant existence in production.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TenantMetadata,
  TenantStatus,
  TenantSettings,
  TenantFeatures,
  TenantLimits,
} from '../middleware/tenant-context.middleware';

/**
 * Tenant response from auth-service
 */
interface TenantApiResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  settings?: Partial<TenantSettings>;
  maxUsers?: number;
  createdAt: string;
  updatedAt: string;
}

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
  trial: {
    maxUsers: 10,
    maxFarms: 5,
    maxPonds: 25,
    maxSensors: 100,
    maxApiRequests: 50000,
    maxStorageGb: 10,
    dataRetentionDays: 90,
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
    maxUsers: -1,
    maxFarms: -1,
    maxPonds: -1,
    maxSensors: -1,
    maxApiRequests: -1,
    maxStorageGb: -1,
    dataRetentionDays: -1,
  },
};

@Injectable()
export class TenantLookupService {
  private readonly logger = new Logger(TenantLookupService.name);
  private readonly authServiceUrl: string;
  private readonly timeout: number;
  private readonly cache = new Map<string, { tenant: TenantMetadata; expiry: number }>();
  private readonly cacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    this.authServiceUrl = this.configService.get<string>(
      'AUTH_SERVICE_URL',
      'http://localhost:3001',
    );
    this.timeout = this.configService.get<number>('TENANT_LOOKUP_TIMEOUT_MS', 5000);
    this.cacheTtl = this.configService.get<number>('TENANT_CACHE_TTL_MS', 300000); // 5 minutes
  }

  /**
   * Lookup tenant by ID from auth-service
   */
  async lookupTenant(tenantId: string): Promise<TenantMetadata | null> {
    // Check cache first
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiry > Date.now()) {
      return cached.tenant;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(
        `${this.authServiceUrl}/api/v1/internal/tenants/${tenantId}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service': 'gateway-api',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug(`Tenant not found: ${tenantId}`);
          return null;
        }
        this.logger.error(`Auth service returned ${response.status} for tenant ${tenantId}`);
        return null;
      }

      const data = (await response.json()) as TenantApiResponse;
      const tenant = this.mapToTenantMetadata(data);

      // Cache the result
      this.cache.set(tenantId, {
        tenant,
        expiry: Date.now() + this.cacheTtl,
      });

      return tenant;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.logger.error(`Tenant lookup timed out for ${tenantId}`);
      } else {
        this.logger.error(`Tenant lookup failed for ${tenantId}:`, (error as Error).message);
      }
      return null;
    }
  }

  /**
   * Map API response to TenantMetadata
   */
  private mapToTenantMetadata(data: TenantApiResponse): TenantMetadata {
    const plan = data.plan.toLowerCase();
    // Use non-null assertion since 'starter' is always defined in our const objects
    const defaultFeatures = PLAN_FEATURES['starter'] as TenantFeatures;
    const defaultLimits = PLAN_LIMITS['starter'] as TenantLimits;
    const planFeatures: TenantFeatures = { ...(PLAN_FEATURES[plan] ?? defaultFeatures) };
    const planLimits: TenantLimits = { ...(PLAN_LIMITS[plan] ?? defaultLimits) };

    // Override maxUsers from tenant settings if available
    if (data.maxUsers && data.maxUsers > 0) {
      planLimits.maxUsers = data.maxUsers;
    }

    // Build complete settings with all required fields
    const settings: TenantSettings = {
      ...DEFAULT_SETTINGS,
      ...(data.settings || {}),
    };

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      status: this.mapStatus(data.status),
      plan,
      settings,
      features: planFeatures,
      limits: planLimits,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  /**
   * Map status string to TenantStatus enum
   */
  private mapStatus(status: string): TenantStatus {
    const statusMap: Record<string, TenantStatus> = {
      active: TenantStatus.ACTIVE,
      suspended: TenantStatus.SUSPENDED,
      pending: TenantStatus.PENDING,
      trial: TenantStatus.TRIAL,
      expired: TenantStatus.EXPIRED,
    };
    return statusMap[status.toLowerCase()] ?? TenantStatus.PENDING;
  }

  /**
   * Invalidate cached tenant
   */
  invalidateCache(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /**
   * Clear all cached tenants
   */
  clearCache(): void {
    this.cache.clear();
  }
}
