import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConsentType, ConsentRecord, ConsentStatus, Role } from '@aquaculture/backend-common';
import { UserConsent } from '@aquaculture/backend-common/gdpr';

import { User } from '../../authentication/entities/user.entity';
import {
  RecordConsentInput,
  ConsentItemInput,
  WithdrawConsentInput,
  UserConsentRecord,
  UserConsentStatus,
  ConsentStatusItem,
  RecordConsentResult,
  BulkConsentResult,
  WithdrawConsentResult,
  ConsentHistoryResponse,
} from '../dto/user-consent.dto';

/**
 * Request context for consent operations
 */
export interface ConsentRequestContext {
  userId: string;
  tenantId?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * UserConsentService
 *
 * Handles user consent operations for GDPR/CCPA compliance.
 * Provides tenant-isolated access to consent data.
 *
 * Key Features:
 * - Record consent (grant or deny)
 * - Withdraw consent with reason tracking
 * - Get current consent status
 * - View consent history
 * - Bulk consent operations
 *
 * Security:
 * - Tenant isolation enforced
 * - Users can only manage their own consents
 * - SuperAdmin can view all consents (read-only)
 */
@Injectable()
export class UserConsentService {
  private readonly logger = new Logger(UserConsentService.name);
  private readonly currentVersion = '2.0.0';

  constructor(
    @InjectRepository(UserConsent)
    private readonly consentRepository: Repository<UserConsent>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  // =========================================================================
  // Consent Recording Operations
  // =========================================================================

  /**
   * Record a single consent for the current user
   */
  async recordConsent(
    context: ConsentRequestContext,
    input: RecordConsentInput,
  ): Promise<RecordConsentResult> {
    const entity = this.consentRepository.create({
      userId: context.userId,
      tenantId: context.tenantId,
      consentType: input.consentType,
      granted: input.granted,
      version: input.version || this.currentVersion,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    const saved = await this.consentRepository.save(entity);

    this.logger.log(
      `Consent recorded for user ${context.userId}: ` +
        `${input.consentType} = ${input.granted}`,
    );

    return {
      id: saved.id,
      success: true,
      message: input.granted
        ? `Consent granted for ${input.consentType}`
        : `Consent denied for ${input.consentType}`,
    };
  }

  /**
   * Record multiple consents at once
   * PERF: Uses batch insert in a single transaction (HIGH-06/M-10)
   */
  async recordBulkConsent(
    context: ConsentRequestContext,
    consents: ConsentItemInput[],
  ): Promise<BulkConsentResult> {
    // Create all entities up front
    const entities = consents.map((consent) =>
      this.consentRepository.create({
        userId: context.userId,
        tenantId: context.tenantId,
        consentType: consent.consentType,
        granted: consent.granted,
        version: this.currentVersion,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      }),
    );

    // Batch insert in a single transaction to ensure atomicity (M-10)
    // and avoid N sequential round-trips (HIGH-06)
    const saved = await this.dataSource.transaction(async (manager) => {
      // context.tenantId can legitimately be null for pre-tenant-signup
      // consents (e.g. cookie/privacy acceptance before the tenant is
      // provisioned). tenantManagerRepo requires a non-null tenantId,
      // so this callsite uses the raw repo and relies on the tenantId
      // already baked into each entity by create() above.
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-signup GDPR consent flow
      return manager.getRepository(UserConsent).save(entities);
    });

    const ids = saved.map((s) => s.id);

    this.logger.log(
      `Bulk consent recorded for user ${context.userId}: ${consents.length} consents`,
    );

    return {
      ids,
      success: true,
      message: `Successfully recorded ${consents.length} consent(s)`,
      recordedCount: ids.length,
    };
  }

  // =========================================================================
  // Consent Withdrawal
  // =========================================================================

  /**
   * Withdraw a specific consent
   */
  async withdrawConsent(
    context: ConsentRequestContext,
    input: WithdrawConsentInput,
  ): Promise<WithdrawConsentResult> {
    // Get latest consent to check if there's anything to withdraw
    const latest = await this.consentRepository.findOne({
      where: { userId: context.userId, consentType: input.consentType },
      order: { createdAt: 'DESC' },
    });

    if (!latest || !latest.granted) {
      this.logger.debug(
        `No active consent to withdraw for user ${context.userId}: ${input.consentType}`,
      );
      return {
        success: true,
        message: `No active consent found for ${input.consentType}`,
        consentType: input.consentType,
      };
    }

    // Create withdrawal record
    const withdrawal = this.consentRepository.create({
      userId: context.userId,
      tenantId: context.tenantId || latest.tenantId,
      consentType: input.consentType,
      granted: false,
      version: this.currentVersion,
      withdrawalReason: input.reason,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        previousConsentId: latest.id,
        previousVersion: latest.version,
        withdrawnAt: new Date().toISOString(),
      },
    });

    await this.consentRepository.save(withdrawal);

    this.logger.log(
      `Consent withdrawn for user ${context.userId}: ${input.consentType} ` +
        `(reason: ${input.reason || 'none'})`,
    );

    return {
      success: true,
      message: `Consent withdrawn for ${input.consentType}`,
      consentType: input.consentType,
    };
  }

  // =========================================================================
  // Consent Status and History
  // =========================================================================

  /**
   * Get current consent status for a user
   */
  async getConsentStatus(userId: string): Promise<UserConsentStatus> {
    // PERF: Single query using DISTINCT ON to get latest consent per type
    // instead of N+1 queries (one per ConsentType enum value)
    const latestPerType: UserConsent[] = await this.consentRepository
      .createQueryBuilder('c')
      .distinctOn(['c.consentType'])
      .where('c.userId = :userId', { userId })
      .orderBy('c.consentType', 'ASC')
      .addOrderBy('c.createdAt', 'DESC')
      .getMany();

    const consentMap = new Map(latestPerType.map((c) => [c.consentType, c]));
    let lastUpdated = new Date(0);
    let latestVersion: string | null = null;

    const consents: ConsentStatusItem[] = Object.values(ConsentType).map((type) => {
      const record = consentMap.get(type);
      if (record) {
        if (record.createdAt > lastUpdated) {
          lastUpdated = record.createdAt;
          latestVersion = record.version;
        }
        return { consentType: type, granted: record.isActive() };
      }
      return { consentType: type, granted: false };
    });

    const isOutdated = !latestVersion || latestVersion !== this.currentVersion;

    return {
      userId,
      lastUpdated: lastUpdated.getTime() > 0 ? lastUpdated : new Date(),
      consentVersion: this.currentVersion,
      isOutdated,
      consents,
    };
  }

  /**
   * Get consent history for a user
   */
  async getConsentHistory(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<ConsentHistoryResponse> {
    const [entities, totalCount] = await this.consentRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    const records: UserConsentRecord[] = entities.map((entity) => ({
      id: entity.id,
      userId: entity.userId,
      tenantId: entity.tenantId,
      consentType: entity.consentType,
      granted: entity.granted,
      version: entity.version,
      ipAddress: entity.ipAddress,
      userAgent: entity.userAgent,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt,
      isActive: entity.isActive(),
    }));

    return {
      records,
      totalCount,
    };
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

  // =========================================================================
  // Admin Operations (Read-only for SuperAdmin)
  // =========================================================================

  /**
   * Get consent status for any user (SuperAdmin only)
   * Used for compliance auditing
   */
  async getConsentStatusForUser(
    requestingUserId: string,
    targetUserId: string,
  ): Promise<UserConsentStatus> {
    // Verify requesting user is SuperAdmin
    const requestingUser = await this.userRepository.findOne({
      where: { id: requestingUserId },
    });

    if (!requestingUser) {
      throw new NotFoundException('Requesting user not found');
    }

    if (requestingUser.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SuperAdmin can view other users\' consent status',
      );
    }

    return this.getConsentStatus(targetUserId);
  }

  /**
   * Get consent history for any user (SuperAdmin only)
   * Used for compliance auditing
   */
  async getConsentHistoryForUser(
    requestingUserId: string,
    targetUserId: string,
    limit = 50,
    offset = 0,
  ): Promise<ConsentHistoryResponse> {
    // Verify requesting user is SuperAdmin
    const requestingUser = await this.userRepository.findOne({
      where: { id: requestingUserId },
    });

    if (!requestingUser) {
      throw new NotFoundException('Requesting user not found');
    }

    if (requestingUser.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SuperAdmin can view other users\' consent history',
      );
    }

    return this.getConsentHistory(targetUserId, limit, offset);
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  /**
   * Get current consent version
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /**
   * Check if user needs to update their consents (version mismatch)
   */
  async isConsentOutdated(userId: string): Promise<boolean> {
    const latest = await this.consentRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latest) return true;
    return latest.version !== this.currentVersion;
  }
}
