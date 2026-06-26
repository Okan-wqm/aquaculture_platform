/**
 * Tenant Lookup Service
 *
 * Provides tenant validation by querying the auth-service.
 * Used by middleware to verify tenant existence in production.
 */

import { signedFetch } from '@aquaculture/backend-common/http';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  TenantMetadata,
  TenantStatus,
  TenantSettings,
  TenantFeatures,
  PLAN_FEATURES,
  TenantLimits,
  resolveTenantLimits,
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


// Plan limits are projected from the canonical PLAN_CATALOG SSoT via
// `resolveTenantLimits` (re-exported from the middleware). The former
// hand-copied PLAN_LIMITS table lived here AND in the middleware and had
// already drifted from billing/admin — both copies are now deleted.

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
          audience: 'auth-service',
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
    const planFeatures: TenantFeatures = { ...(PLAN_FEATURES[plan] ?? defaultFeatures) };
    // Canonical limits projected from the PLAN_CATALOG SSoT (unknown plan → STARTER).
    const planLimits: TenantLimits = resolveTenantLimits(plan);

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
      status: this.coerceStatus(data.status),
      plan,
      settings,
      features: planFeatures,
      limits: planLimits,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  /**
   * Coerce the raw tenant-status string from the lookup source into the
   * canonical TenantStatus (MT-HIGH-003). The source persists canonical
   * UPPERCASE values, so this is a validating passthrough — the old
   * `mapStatus` lowercase shim (which also invented non-canonical trial/
   * expired entries) is gone. An unrecognised value fails closed to PENDING
   * rather than being trusted blindly.
   */
  private coerceStatus(raw: string): TenantStatus {
    // String(s) keeps both sides of the comparison `string`-typed (avoids the
    // enum-vs-string no-unsafe-enum-comparison) while still returning the
    // matched TenantStatus member — no cast.
    return Object.values(TenantStatus).find((s) => String(s) === raw) ?? TenantStatus.PENDING;
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
      const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].expiry - b[1].expiry);
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
