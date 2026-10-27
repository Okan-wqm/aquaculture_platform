/**
 * Device Ownership Verification Service
 *
 * Provides tenant-scoped device ownership verification via NATS request-reply
 * to sensor-service. Implements an LRU cache with configurable maximum size,
 * separate TTLs for positive and negative results, and periodic cleanup to
 * prevent unbounded memory growth (SEC-M18 / BULGU-1 / ONEMLI-02).
 *
 * The LRU cache is implemented without external dependencies using a Map
 * (which preserves insertion order in ES2015+) combined with a size check.
 * On eviction, the oldest entry (first key in iteration order) is removed.
 * Entries are promoted to "most recently used" by delete-then-set.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import { NATS_PATTERNS } from '@aquaculture/backend-common/constants';
import { devicePlacementOf, type DevicePlacement } from '@platform/event-contracts';

/** Shape of a single cache entry: the device's placement, or null when the tenant owns none. */
interface CacheEntry {
  placement: DevicePlacement | null;
  expiresAt: number;
}

/**
 * Injectable service that verifies edge-device ownership for a given tenant,
 * answers with the device's site (SEC-CRITICAL-207: a site-bound sensor
 * operator streams the devices of its own sites only) and caches results in a
 * bounded LRU map.
 */
@Injectable()
export class DeviceOwnershipService implements OnModuleDestroy {
  private readonly logger = new Logger(DeviceOwnershipService.name);

  /** LRU cache: key = `${tenantId}:${deviceCode}` */
  private readonly cache = new Map<string, CacheEntry>();

  /** Maximum number of entries allowed in the cache. */
  private readonly maxCacheSize: number;

  /** TTL for positive (owned=true) results in milliseconds. */
  private readonly positiveTtlMs: number;

  /** TTL for negative (owned=false) results in milliseconds. */
  private readonly negativeTtlMs: number;

  /** Timeout for NATS ownership verification requests in milliseconds. */
  private readonly verifyTimeoutMs: number;

  /**
   * When true, device ownership checks are bypassed entirely.
   * Controlled by SKIP_DEVICE_AUTH env var (default: false).
   */
  private readonly skipDeviceAuth: boolean;

  /** Handle for the periodic cleanup interval. */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.maxCacheSize = this.configService.get<number>(
      'DEVICE_OWNERSHIP_CACHE_MAX_SIZE',
      10_000,
    );
    this.positiveTtlMs = this.configService.get<number>(
      'DEVICE_OWNERSHIP_POSITIVE_TTL_MS',
      5 * 60 * 1000, // 5 minutes
    );
    this.negativeTtlMs = this.configService.get<number>(
      'DEVICE_OWNERSHIP_NEGATIVE_TTL_MS',
      30 * 1000, // 30 seconds
    );
    this.verifyTimeoutMs = this.configService.get<number>(
      'DEVICE_OWNERSHIP_VERIFY_TIMEOUT_MS',
      5_000,
    );
    this.skipDeviceAuth = this.configService.get<string>(
      'SKIP_DEVICE_AUTH',
      'false',
    ) === 'true';

    // Start periodic cleanup every 60 seconds
    const cleanupIntervalMs = this.configService.get<number>(
      'DEVICE_OWNERSHIP_CLEANUP_INTERVAL_MS',
      60_000,
    );
    this.cleanupInterval = setInterval(
      () => this.evictExpiredEntries(),
      cleanupIntervalMs,
    );

    // Prevent the cleanup timer from keeping the process alive during shutdown
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    this.logger.log(
      `DeviceOwnershipService initialized — maxSize=${this.maxCacheSize}, ` +
      `positiveTtl=${this.positiveTtlMs}ms, negativeTtl=${this.negativeTtlMs}ms, ` +
      `skipDeviceAuth=${this.skipDeviceAuth}`,
    );
  }

  /**
   * Where an edge device of a specific tenant stands.
   *
   * Checks the LRU cache first. On a miss, sends a NATS request-reply to
   * sensor-service. The result is cached with a TTL that depends on whether
   * the device was found (positive) or not (negative).
   *
   * Safe defaults:
   * - If SKIP_DEVICE_AUTH is true and NATS is not wired: owned, on no site
   *   (development only; a site-bound caller is still refused)
   * - If NATS client is not available and SKIP_DEVICE_AUTH is false: none
   * - If sensor-service is unreachable, times out or replies malformed: none
   * - If cache entry exists and has not expired: use cached result
   *
   * @param deviceCode - The edge device code to verify
   * @param tenantId - The tenant ID from the authenticated JWT
   * @returns the device's placement when the tenant owns it, null otherwise
   */
  async devicePlacement(
    deviceCode: string,
    tenantId: string,
  ): Promise<DevicePlacement | null> {
    // Check cache first (with LRU promotion)
    const cacheKey = `${tenantId}:${deviceCode}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        // Promote to most-recently-used position
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return cached.placement;
      }
      // Evict expired entry
      this.cache.delete(cacheKey);
    }

    if (!this.natsClient) {
      this.logger.warn(
        'SEC-M18: NATS client not available for device ownership verification',
      );
      return this.skipDeviceAuth ? { siteId: null } : null;
    }

    try {
      const reply = await firstValueFrom(
        this.natsClient
          .send<unknown>(
            NATS_PATTERNS.SENSOR.VERIFY_DEVICE_OWNERSHIP,
            { deviceCode, tenantId },
          )
          .pipe(timeout(this.verifyTimeoutMs)),
      );

      const placement = devicePlacementOf(reply);
      const ttl = placement !== null ? this.positiveTtlMs : this.negativeTtlMs;

      this.setCacheEntry(cacheKey, { placement, expiresAt: Date.now() + ttl });

      return placement;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `SEC-M18: Device ownership verification failed (denying access): ${message}`,
      );
      // Safe default: deny access when sensor-service is unreachable
      return null;
    }
  }

  /**
   * Clear the cleanup interval on module destruction to prevent memory leaks
   * and allow the Node.js process to exit cleanly.
   */
  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
    this.logger.log('DeviceOwnershipService destroyed — cache cleared');
  }

  /**
   * Insert a cache entry, evicting the oldest entry if the cache has
   * reached its maximum size. The Map iteration order (insertion order)
   * is used as the LRU approximation.
   */
  private setCacheEntry(key: string, entry: CacheEntry): void {
    // If key already exists, delete first so re-insertion moves it to the end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries until we have room
    while (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value as string;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, entry);
  }

  /**
   * Remove all expired entries from the cache. Called periodically by
   * the cleanup interval to prevent stale data from consuming memory
   * even when those keys are never re-queried (lazy eviction alone
   * does not handle this case).
   */
  private evictExpiredEntries(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.logger.debug(
        `Cache cleanup: evicted ${evicted} expired entries, ${this.cache.size} remaining`,
      );
    }
  }
}
