import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { IEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  tenantScopeOf,
  type ConsentRecordedEvent,
  type ConsentWithdrawnEvent,
} from '@platform/event-contracts';

import { IConsentManager, ConsentRecord, ConsentStatus, ConsentType } from '../interfaces';
import { UserConsent } from './entities/consent.entity';

/**
 * Consent Manager Service
 *
 * Manages user consent for GDPR/CCPA compliance:
 * - Records consent grants and withdrawals
 * - Tracks consent history
 * - Validates consent before data processing
 *
 * SOLID Principles:
 * - Single Responsibility: Only manages consent
 * - Interface Segregation: Implements IConsentManager
 */
@Injectable()
export class ConsentManagerService implements IConsentManager {
  private readonly logger = new Logger(ConsentManagerService.name);
  private readonly currentVersion = '2.0.0';

  constructor(
    @InjectRepository(UserConsent)
    private readonly consentRepository: Repository<UserConsent>,
    // COMPLIANCE-HIGH-002 cure: GDPR Art 7(3) requires consent
    // withdrawal to take effect "as easily as it was given" — every
    // ConsentRecorded / ConsentWithdrawn must be emitted so downstream
    // consumers (AI analytics, marketing automation, profiling
    // pipelines) can pause processing within seconds. @Optional so
    // local-dev paths without event-bus wiring still compile and
    // record consent; production registers EVENT_BUS via
    // EventBusModule.
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  /**
   * COMPLIANCE-HIGH-002 cure helper: emit a consent event with
   * defensive try/catch. The DB write is the legal record-of-truth
   * (atomic with the Repository.save above); event emission is
   * best-effort downstream notification — a failed publish must NOT
   * block the consent operation itself or operators won't be able to
   * record consent at all when the bus is down.
   */
  private async emitConsentEvent(
    event: ConsentRecordedEvent | ConsentWithdrawnEvent,
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      this.logger.warn(
        `Consent event ${event.eventType} publish failed (non-fatal — DB record persisted): ${msg}`,
      );
    }
  }

  /**
   * Record user consent
   */
  async recordConsent(consent: ConsentRecord): Promise<string> {
    const entity = this.consentRepository.create({
      userId: consent.userId,
      tenantId: consent.tenantId,
      consentType: consent.consentType,
      granted: consent.granted,
      version: consent.version || this.currentVersion,
      ipAddress: consent.ipAddress,
      userAgent: consent.userAgent,
      expiresAt: consent.expiresAt,
      metadata: consent.metadata,
    });

    const saved = await this.consentRepository.save(entity);

    this.logger.log(
      `Consent recorded for user ${consent.userId}: ` +
        `${consent.consentType} = ${consent.granted}`,
    );

    // COMPLIANCE-HIGH-002 cure: emit ConsentRecorded so downstream
    // services (AI analytics, marketing, profiling) update their
    // per-user processing flags within seconds. `granted=false` here
    // would be a deny-on-grant variant (rare); the canonical
    // withdrawal path is withdrawConsent() which emits the explicit
    // ConsentWithdrawn event.
    if (consent.granted) {
      await this.emitConsentEvent({
        ...createBaseEvent<ConsentRecordedEvent>(
          'ConsentRecorded',
          tenantScopeOf(consent.tenantId),
          { aggregateId: saved.id, aggregateType: 'UserConsent' },
        ),
        userId: consent.userId,
        consentType: String(consent.consentType),
        consentVersion: consent.version || this.currentVersion,
        legalBasis: 'consent',
      });
    }

    return saved.id;
  }

  /**
   * Get current consent status for user
   */
  async getConsentStatus(userId: string): Promise<ConsentStatus> {
    const consents = new Map<ConsentType, boolean>();
    let lastUpdated = new Date(0);

    // Get latest consent for each type
    for (const type of Object.values(ConsentType)) {
      const latest = await this.consentRepository.findOne({
        where: { userId, consentType: type },
        order: { createdAt: 'DESC' },
      });

      if (latest) {
        consents.set(type, latest.isActive());
        if (latest.createdAt > lastUpdated) {
          lastUpdated = latest.createdAt;
        }
      } else {
        consents.set(type, false);
      }
    }

    return {
      userId,
      consents: Object.fromEntries(consents) as Record<ConsentType, boolean>,
      lastUpdated,
      consentVersion: this.currentVersion,
    };
  }

  /**
   * Withdraw consent
   */
  async withdrawConsent(userId: string, consentType: ConsentType, reason?: string): Promise<void> {
    // Get latest consent
    const latest = await this.consentRepository.findOne({
      where: { userId, consentType },
      order: { createdAt: 'DESC' },
    });

    if (!latest || !latest.granted) {
      this.logger.debug(`No active consent to withdraw for user ${userId}: ${consentType}`);
      return;
    }

    // Create withdrawal record
    const withdrawal = this.consentRepository.create({
      userId,
      tenantId: latest.tenantId,
      consentType,
      granted: false,
      version: this.currentVersion,
      withdrawalReason: reason,
      metadata: {
        previousConsentId: latest.id,
        previousVersion: latest.version,
      },
    });

    const savedWithdrawal = await this.consentRepository.save(withdrawal);

    this.logger.log(
      `Consent withdrawn for user ${userId}: ${consentType} (reason: ${reason || 'none'})`,
    );

    // COMPLIANCE-HIGH-002 cure: emit ConsentWithdrawn so AI analytics,
    // marketing automation, and profiling pipelines pause processing
    // within seconds. GDPR Art 7(3) instant-effect contract — without
    // this event, the user_consents row lands but downstream services
    // never learn of the withdrawal and continue processing as if the
    // consent were still active.
    await this.emitConsentEvent({
      ...createBaseEvent<ConsentWithdrawnEvent>(
        'ConsentWithdrawn',
        tenantScopeOf(latest.tenantId),
        { aggregateId: savedWithdrawal.id, aggregateType: 'UserConsent' },
      ),
      userId,
      consentType: String(consentType),
      reason,
    });
  }

  /**
   * Get consent history for user
   */
  async getConsentHistory(userId: string): Promise<ConsentRecord[]> {
    const entities = await this.consentRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return entities.map((entity) => ({
      id: entity.id,
      userId: entity.userId,
      tenantId: entity.tenantId || undefined,
      consentType: entity.consentType,
      granted: entity.granted,
      version: entity.version,
      ipAddress: entity.ipAddress || undefined,
      userAgent: entity.userAgent || undefined,
      timestamp: entity.createdAt,
      expiresAt: entity.expiresAt || undefined,
      metadata: entity.metadata || undefined,
    }));
  }

  /**
   * Check if user has given specific consent
   */
  async hasConsent(userId: string, consentType: ConsentType): Promise<boolean> {
    const latest = await this.consentRepository.findOne({
      where: { userId, consentType },
      order: { createdAt: 'DESC' },
    });

    return latest?.isActive() ?? false;
  }

  /**
   * Record multiple consents at once
   */
  async recordBulkConsent(
    userId: string,
    consents: { type: ConsentType; granted: boolean }[],
    metadata?: {
      ipAddress?: string;
      userAgent?: string;
      tenantId?: string;
    },
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const consent of consents) {
      const id = await this.recordConsent({
        userId,
        tenantId: metadata?.tenantId,
        consentType: consent.type,
        granted: consent.granted,
        version: this.currentVersion,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
      ids.push(id);
    }

    return ids;
  }

  /**
   * Check if consent version is outdated
   */
  async isConsentOutdated(userId: string): Promise<boolean> {
    const latest = await this.consentRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latest) return true;

    return latest.version !== this.currentVersion;
  }

  /**
   * Get users with outdated consent
   */
  async getUsersWithOutdatedConsent(limit = 100): Promise<string[]> {
    const result = await this.consentRepository
      .createQueryBuilder('consent')
      .select('DISTINCT consent.userId', 'userId')
      .where('consent.version != :version', { version: this.currentVersion })
      .limit(limit)
      .getRawMany();

    return result.map((r) => r.userId);
  }

  /**
   * Get current consent version
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }
}
