import { Injectable, Logger, NotFoundException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';

import { User } from '../modules/authentication/entities/user.entity';
import { RefreshToken } from '../modules/authentication/entities/refresh-token.entity';
import { AuthenticationService } from '../modules/authentication/services/authentication.service';
import { WebAuthnService } from '../modules/authentication/services/webauthn.service';

/**
 * WHY THIS FILE EXISTS:
 * The auth-service manages user accounts, passwords, sessions, and JWT tokens.
 * GDPR right-to-erasure (Article 17) and right-of-access (Article 15) require
 * this service to:
 *   1. Revoke all active sessions and refresh tokens
 *   2. Anonymize the user's account PII (email, name)
 *   3. Export the auth-layer personal data on request
 *
 * BEFORE: This file was 0 bytes — a stub with no implementation. GDPR erasure
 * at the auth layer silently did nothing, leaving sessions and tokens active
 * and user PII (email, names) intact even after a deletion request.
 *
 * SCOPE: This service owns ONLY the auth-layer data.
 * Cross-service GDPR operations (messages, HR records, sensor data) are handled
 * by each service when they receive the UserDeleted NATS event from auth-service.
 */

export interface GdprAuthExport {
  userId: string;
  email: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  activeRefreshTokenCount: number;
  role: string;
  /** M-GDPR-02: MFA registration status (not the secrets, just that it's registered) */
  webAuthnCredentialCount: number;
  /** M-GDPR-02: Account status */
  isActive: boolean;
}

@Injectable()
export class GdprComplianceService {
  private readonly logger = new Logger(GdprComplianceService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthenticationService,
    private readonly webAuthnService: WebAuthnService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  /**
   * Execute GDPR right-to-erasure for a user at the auth layer.
   *
   * 1. Verify user exists and belongs to the tenant
   * 2. Revoke all active sessions and refresh tokens
   * 3. Anonymize PII fields (email, password — makes account irrecoverable)
   */
  async executeErasure(
    userId: string,
    tenantId: string,
    requestedBy: string,
  ): Promise<void> {
    this.logger.log(`GDPR erasure initiated: userId=${userId} requestedBy=${requestedBy}`);

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found in tenant ${tenantId}`);
    }

    // Revoke all sessions and tokens first — prevents further authentication
    // with any existing credentials while erasure is in progress.
    await this.authService.logoutAllDevices(userId);

    // M-GDPR-03: Delete WebAuthn credentials (passkeys/security keys).
    // credentialPublicKey is linked to a physical device owned by the user —
    // constitutes personal data under strict GDPR interpretation.
    await this.webAuthnService.removeAllCredentials(userId);

    // Anonymize PII fields and lock account in one transaction.
    // Email is replaced with a non-reversible placeholder that preserves
    // uniqueness (userId-scoped) so the DB unique constraint is not violated.
    // WHY placeholder format: some services hold email as a FK-like reference;
    // 'deleted-{userId}@gdpr.local' preserves referential integrity while
    // making the original email unrecoverable.
    await this.dataSource.transaction(async (manager) => {
      // User entity has no updatedBy field — requestedBy is logged above for audit trail.
      await manager.update(User, { id: userId }, {
        email: `deleted-${userId}@gdpr.local`,
        password: '',
        isActive: false,
      });

      // Belt-and-suspenders: ensure all refresh tokens are revoked even if
      // logoutAllDevices() missed any due to a race condition.
      await manager.update(
        RefreshToken,
        { userId, isRevoked: false },
        { isRevoked: true, revokedAt: new Date(), revokedReason: 'GDPR erasure' },
      );
    });

    this.logger.log(`GDPR erasure completed: userId=${userId}`);

    // M-GDPR-01: Publish UserDeleted event so downstream services (messaging, hr,
    // farm, sensor) can run their own GDPR cleanup. Without this event, cross-service
    // anonymisation never triggers — only auth-layer PII is erased.
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('UserDeleted' as any, tenantId, { userId: requestedBy }),
          deletedUserId: userId,
          tenantId,
          erasureType: 'gdpr_right_to_erasure',
        });
        this.logger.log(`UserDeleted event published for userId=${userId}`);
      } catch (eventError) {
        this.logger.error(
          `Failed to publish UserDeleted event for ${userId}: ${(eventError as Error).message}`,
        );
      }
    }
  }

  /**
   * Export all auth-layer personal data for a user (GDPR Article 15 — right of access).
   *
   * Returns account metadata and token summary.
   * Application data (messages, records) is exported by each service separately.
   */
  async exportUserData(userId: string, tenantId: string): Promise<GdprAuthExport> {
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found in tenant ${tenantId}`);
    }

    const activeRefreshTokenCount = await this.refreshTokenRepository.count({
      where: { userId, isRevoked: false },
    });

    // M-GDPR-02: Include MFA status in export (GDPR Article 15 completeness)
    const webAuthnCredentialCount = await this.webAuthnService
      .hasCredentials?.((user as unknown as { id: string }).id)
      .catch(() => false) ? 1 : 0;

    // Count actual credentials for the export
    const credCount = await this.webAuthnService.credentialRepository
      ? await (this.webAuthnService as unknown as { credentialRepository: { count: (opts: unknown) => Promise<number> } })
          .credentialRepository.count({ where: { userId } }).catch(() => 0)
      : 0;

    return {
      userId: user.id,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: (user as unknown as { lastLoginAt?: Date }).lastLoginAt ?? null,
      activeRefreshTokenCount,
      role: user.role,
      webAuthnCredentialCount: credCount,
      isActive: (user as unknown as { isActive?: boolean }).isActive ?? true,
    };
  }
}
