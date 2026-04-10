/**
 * @module StorageQuotaService
 * @description Per-tenant storage quota enforcement for messaging media uploads.
 * Tracks usage from message_attachments table, caches in Redis with 5-minute TTL,
 * and publishes StorageWarning events when usage exceeds 80%.
 * @see ADR-012 section 4.3 (Attachments / Storage)
 */
import { Injectable, Logger, BadRequestException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import Redis from 'ioredis';

import { MessageAttachment } from '../entities/message-attachment.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/** Default per-tenant storage quota: 10 GB in bytes. */
const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

/** Redis cache TTL for storage usage: 5 minutes. */
const CACHE_TTL_SECONDS = 300;

/** Alert threshold: warn when usage exceeds this fraction of quota. */
const STORAGE_WARNING_THRESHOLD = 0.8;

/** Storage statistics returned by getStorageStats. */
export interface StorageStats {
  used: number;
  quota: number;
  percentage: number;
  nearLimit: boolean;
}

/**
 * Enforces per-tenant storage quotas for messaging media uploads.
 *
 * Usage is computed from SUM(file_size) of message_attachments and cached in
 * Redis for 5 minutes. The cache is invalidated on each upload completion.
 */
@Injectable()
export class StorageQuotaService {
  private readonly logger = new Logger(StorageQuotaService.name);

  constructor(
    @InjectRepository(MessageAttachment)
    private readonly attachmentRepo: Repository<MessageAttachment>,
    @InjectRepository(MessagingOutbox)
    private readonly outboxRepo: Repository<MessagingOutbox>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Get total storage used by a tenant in bytes.
   * Reads from Redis cache first; falls back to DB query on miss.
   */
  async getStorageUsed(tenantId: string): Promise<number> {
    const cacheKey = this.usageCacheKey(tenantId);

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return parseInt(cached, 10);
      }
    } catch (err) {
      this.logger.warn(`Redis cache read failed for storage usage: ${(err as Error).message}`);
    }

    // DB fallback: SUM(file_size) for all attachments in this tenant's schema.
    // Tenant isolation is enforced at the PostgreSQL schema level (tenant_* schemas),
    // so no explicit tenantId WHERE clause is needed here.
    const result = await this.attachmentRepo
      .createQueryBuilder('att')
      .select('COALESCE(SUM(att."fileSize"), 0)', 'total')
      .getRawOne<{ total: string }>();

    const totalBytes = parseInt(result?.total ?? '0', 10);

    // Cache the result
    try {
      await this.redis.setex(cacheKey, CACHE_TTL_SECONDS, totalBytes.toString());
    } catch (err) {
      this.logger.warn(`Redis cache write failed for storage usage: ${(err as Error).message}`);
    }

    return totalBytes;
  }

  /**
   * Get the storage quota for a tenant in bytes.
   * Reads from tenant configuration or falls back to default.
   */
  async getStorageQuota(tenantId: string): Promise<number> {
    // Check tenant-specific config in Redis
    const configKey = `msg:tenant:${tenantId}:storage_quota`;

    try {
      const configured = await this.redis.get(configKey);
      if (configured !== null) {
        return parseInt(configured, 10);
      }
    } catch (err) {
      this.logger.warn(`Redis config read failed: ${(err as Error).message}`);
    }

    // Return configurable default
    return this.configService.get<number>(
      'MESSAGING_STORAGE_QUOTA_BYTES',
      DEFAULT_QUOTA_BYTES,
    );
  }

  /**
   * Check if the tenant has enough storage available for a new file.
   */
  async hasStorageAvailable(tenantId: string, newFileSize: number): Promise<boolean> {
    const [used, quota] = await Promise.all([
      this.getStorageUsed(tenantId),
      this.getStorageQuota(tenantId),
    ]);

    return used + newFileSize <= quota;
  }

  /**
   * Get comprehensive storage statistics for a tenant.
   */
  async getStorageStats(tenantId: string): Promise<StorageStats> {
    const [used, quota] = await Promise.all([
      this.getStorageUsed(tenantId),
      this.getStorageQuota(tenantId),
    ]);

    const percentage = quota > 0 ? (used / quota) * 100 : 0;
    const nearLimit = percentage >= STORAGE_WARNING_THRESHOLD * 100;

    return { used, quota, percentage, nearLimit };
  }

  /**
   * Validate storage quota before an upload. Throws if quota is exceeded.
   * Also publishes a StorageWarning event if usage is above 80%.
   */
  async enforceQuota(tenantId: string, newFileSize: number): Promise<void> {
    const [used, quota] = await Promise.all([
      this.getStorageUsed(tenantId),
      this.getStorageQuota(tenantId),
    ]);

    if (used + newFileSize > quota) {
      throw new BadRequestException(
        'Storage quota exceeded. Please contact your administrator to increase your storage limit.',
      );
    }

    // Check warning threshold
    // IMPORTANT: Route StorageWarning through transactional outbox instead of
    // direct eventBus emit. If NATS is down when quota is breached, direct emit
    // silently loses the event. Outbox guarantees at-least-once delivery.
    // @see MSG-MEDIUM-008
    const usageAfterUpload = (used + newFileSize) / quota;
    if (usageAfterUpload >= STORAGE_WARNING_THRESHOLD) {
      await this.outboxRepo.save(
        this.outboxRepo.create({
          tenantId,
          eventType: 'StorageWarning',
          payload: {
            tenantId,
            usedBytes: used + newFileSize,
            quotaBytes: quota,
            usagePercentage: Math.round(usageAfterUpload * 100),
            timestamp: new Date().toISOString(),
          },
        }),
      );
      this.logger.warn(
        `Tenant ${tenantId} storage at ${Math.round(usageAfterUpload * 100)}% ` +
        `(${used + newFileSize}/${quota} bytes)`,
      );
    }
  }

  /**
   * Invalidate the cached storage usage for a tenant.
   * Should be called after a successful upload.
   */
  async invalidateCache(tenantId: string): Promise<void> {
    try {
      await this.redis.del(this.usageCacheKey(tenantId));
    } catch (err) {
      this.logger.warn(`Redis cache invalidation failed: ${(err as Error).message}`);
    }
  }

  /** Build the Redis cache key for tenant storage usage. */
  private usageCacheKey(tenantId: string): string {
    return `msg:tenant:${tenantId}:storage_used`;
  }
}
