/**
 * Tenant Lookup Service
 *
 * Provides tenant validation by querying the auth-service.
 * Used by middleware to verify tenant existence in production.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signedFetch } from '@aquaculture/backend-common/http';
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
  private readonly maxCacheSize: number;

  constructor(private readonly configService: ConfigService) {
    this.authServiceUrl = this.configService.get<string>(
      'AUTH_SERVICE_URL',
      'http://localhost:3001',
    );
    this.timeout = this.configService.get<number>('TENANT_LOOKUP_TIMEOUT_MS', 5000);
    this.cacheTtl = this.configService.get<number>('TENANT_CACHE_TTL_MS', 300000); // 5 minutes
    this.maxCacheSize = this.configService.get<number>('TENANT_CACHE_MAX_SIZE', 1000);

    // SECURITY (HIGH-003): internal calls use signedFetch with the v2
    // service-identity keyring. Emit a startup log so misconfiguration is
    // surfaced in deploy logs as well as in the call site.
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (
      isProduction &&
      (!this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ||
        !this.configService.get<string>('SERVICE_IDENTITY_SIGNING_KID'))
    ) {
      this.logger.error(
        'SECURITY: SERVICE_IDENTITY_KEYRING and SERVICE_IDENTITY_SIGNING_KID are required in production. ' +
          'Every call to lookupTenant() will throw until service identity signing material is provided.',
      );
    }
  }

  /**
   * Lookup tenant by ID from auth-service
   * SECURITY: Validates tenantId format to prevent SSRF/path-injection via crafted IDs.
   */
  async lookupTenant(tenantId: string): Promise<TenantMetadata | null> {
    // SECURITY: Validate tenantId is a valid UUID to prevent path injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      this.logger.warn(`Invalid tenant ID format rejected: ${tenantId.substring(0, 40)}`);
      return null;
    }

    // Check cache first
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiry > Date.now()) {
      return cached.tenant;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // SECURITY (HIGH-003): signedFetch attaches HMAC-signed X-Service-*
      // headers with tenantId bound into the signature — replaces the older
      // X-Internal-Service / X-Internal-Service-Secret scheme which passed
      // the secret in plaintext and was trivially spoofable.
      const response = await signedFetch(
        `${this.authServiceUrl}/api/v1/internal/tenants/${tenantId}`,
        {
          method: 'GET',
          serviceName: 'gateway-api',
          tenantId,
          headers: { 'Content-Type': 'application/json' },
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

      // Cache the result with size limit enforcement
      this.cache.set(tenantId, {
        tenant,
        expiry: Date.now() + this.cacheTtl,
      });
      this.enforceCacheSizeLimit();

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
   * Enforce cache size limit to prevent unbounded memory growth
   */
  private enforceCacheSizeLimit(): void {
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }
    // Remove expired entries first
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (value.expiry < now) {
        this.cache.delete(key);
      }
    }
    // If still over limit, remove oldest entries
    if (this.cache.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.entries())
        .sort((a, b) => a[1].expiry - b[1].expiry);
      const toRemove = entries.slice(0, entries.length - this.maxCacheSize);
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }
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
