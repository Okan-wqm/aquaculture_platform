import { Injectable, Logger, NotFoundException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { LegalHoldService, HoldScope } from '@aquaculture/backend-common/compliance';

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
    // LEGAL-HIGH-005 cure: GDPR right-to-erasure is a destructive op
    // that MUST consult the canonical legal-hold registry before
    // proceeding. @Optional because the legal-hold infrastructure may
    // not be wired during local-dev-without-DB scenarios — production
    // registers it via LegalHoldModule.forRoot() in app.module.ts.
    @Optional()
    private readonly legalHoldService?: LegalHoldService,
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

    // LEGAL-HIGH-005 cure: BEFORE any destructive op, consult the
    // canonical legal-hold registry. A tenant-wide hold blocks ALL
    // erasure under that tenant; a user-scoped hold blocks just this
    // user. If the legal-hold infrastructure isn't wired (local-dev
    // path), the optional dependency is undefined and the check is
    // skipped — production has the module registered and the assert
    // throws LegalHoldActiveError on hit.
    if (this.legalHoldService) {
      await this.legalHoldService.assertNoHold(tenantId, 'tenant');
      await this.legalHoldService.assertNoHold(tenantId, 'user', userId);
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
          ...createBaseEvent('UserDeleted', tenantId, { userId: requestedBy }),
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
    // Use public API instead of accessing private credentialRepository
    const credentials = await this.webAuthnService
      .getUserCredentials?.(userId)
      .catch(() => []);
    const credCount = credentials?.length ?? 0;

    return {
      userId: user.id,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
      activeRefreshTokenCount,
      role: user.role,
      webAuthnCredentialCount: credCount,
      isActive: user.isActive ?? true,
    };
  }
}
