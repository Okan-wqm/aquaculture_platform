/**
 * PlatformCapabilityService — the single writer of
 * `auth.platform_capability_grants` (ADR-0016, SEC-HIGH-059).
 *
 * Policy lives here, once:
 *   - only an ACTIVE SUPER_ADMIN can hold a capability;
 *   - `break-glass` needs an `expiresAt` within four hours and a grantor other
 *     than the target (dual control); standing capabilities may be open-ended;
 *   - a capability is live at most once per user (the partial unique index is
 *     the database's word; the pre-check turns the violation into a typed
 *     conflict instead of a driver error);
 *   - every grant and revoke revokes the target's refresh tokens and advances
 *     the durable access-token invalidation epoch, so the
 *     `platformCapabilities` claim re-mints on the next token instead of
 *     surviving until natural expiry (the same path a role change takes);
 *   - every grant and revoke is an audit row written inside the same
 *     transaction — a capability change with no evidence cannot commit.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  BREAK_GLASS_MAX_TTL_SECONDS,
  isPlatformCapability,
  type PlatformCapability,
  type PlatformCapabilityGrantSnapshot,
} from '@platform/event-contracts';
import { DataSource, IsNull, Repository } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { User } from '../../authentication/entities/user.entity';
import {
  DurableUserTokenInvalidationService,
  type UserTokenInvalidationIntent,
} from '../../authentication/services/durable-user-token-invalidation.service';
import {
  LIVE_PLATFORM_CAPABILITY_GRANT_SQL,
  PlatformCapabilityGrant,
} from '../entities/platform-capability-grant.entity';

import {
  createCredentialInvalidationIntent,
  lockUserForCredentialMutation,
  revokeActiveRefreshTokens,
} from './user-credential-revocation';

export class PlatformCapabilityPolicyError extends BadRequestException {
  constructor(
    readonly code:
      | 'INVALID_CAPABILITY'
      | 'SELF_GRANT_FORBIDDEN'
      | 'EXPIRY_REQUIRED'
      | 'EXPIRY_TOO_LONG'
      | 'EXPIRY_IN_PAST'
      | 'VALIDATION_ERROR',
    message: string,
  ) {
    super(message);
  }
}

export class NotPlatformAdminError extends ForbiddenException {
  readonly code = 'NOT_PLATFORM_ADMIN' as const;
}

export class CapabilityAlreadyGrantedError extends ConflictException {
  readonly code = 'ALREADY_GRANTED' as const;
}

export class CapabilityGrantNotFoundError extends NotFoundException {
  readonly code = 'GRANT_NOT_FOUND' as const;
}

export interface GrantPlatformCapabilityInput {
  userId: string;
  capability: string;
  grantedBy: string;
  expiresAt?: string;
  reason: string;
}

export interface RevokePlatformCapabilityInput {
  userId: string;
  capability: string;
  revokedBy: string;
  reason: string;
}

const MAX_REASON_LENGTH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toGrantSnapshot(grant: PlatformCapabilityGrant): PlatformCapabilityGrantSnapshot {
  return {
    id: grant.id,
    userId: grant.userId,
    capability: grant.capability,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt.toISOString(),
    expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
    revokedBy: grant.revokedBy,
    revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
    reason: grant.reason,
  };
}

@Injectable()
export class PlatformCapabilityService {
  private readonly logger = new Logger(PlatformCapabilityService.name);

  constructor(
    @InjectRepository(PlatformCapabilityGrant)
    private readonly grantRepository: Repository<PlatformCapabilityGrant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly durableUserTokenInvalidation: DurableUserTokenInvalidationService,
  ) {}

  /** The capabilities a user holds right now — exactly what the next token carries. */
  async liveCapabilities(userId: string): Promise<PlatformCapability[]> {
    const rows = await this.grantRepository
      .createQueryBuilder('g')
      .select('g.capability', 'capability')
      .where('g.userId = :userId', { userId })
      .andWhere(LIVE_PLATFORM_CAPABILITY_GRANT_SQL)
      .orderBy('g.capability', 'ASC')
      .getRawMany<{ capability: string }>();
    return rows.map((row) => row.capability).filter(isPlatformCapability);
  }

  async listGrants(userId: string): Promise<{
    grants: PlatformCapabilityGrantSnapshot[];
    active: PlatformCapability[];
  }> {
    const user = await this.userRepository.findOne({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException(`User with ID "${userId}" not found`);
    const [grants, active] = await Promise.all([
      this.grantRepository.find({ where: { userId }, order: { grantedAt: 'DESC' } }),
      this.liveCapabilities(userId),
    ]);
    return { grants: grants.map(toGrantSnapshot), active };
  }

  async grant(
    input: GrantPlatformCapabilityInput,
    now = new Date(),
  ): Promise<PlatformCapabilityGrant> {
    const capability = this.validateCapability(input.capability);
    const reason = this.validateReason(input.reason);
    this.validateActor(input.grantedBy);
    const expiresAt = this.validateExpiry(capability, input.expiresAt, now);
    if (capability === 'break-glass' && input.grantedBy === input.userId) {
      throw new PlatformCapabilityPolicyError(
        'SELF_GRANT_FORBIDDEN',
        "'break-glass' is dual-controlled: it must be granted by another SUPER_ADMIN",
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const user = await lockUserForCredentialMutation(manager, this.userRepository, input.userId);
      if (!user) throw new NotFoundException(`User with ID "${input.userId}" not found`);
      if (user.role !== Role.SUPER_ADMIN || !user.isActive) {
        throw new NotPlatformAdminError(
          'Platform capabilities can only be granted to an active SUPER_ADMIN',
        );
      }

      const grants = manager.withRepository(this.grantRepository);
      const live = await grants
        .createQueryBuilder('g')
        .where('g.userId = :userId', { userId: user.id })
        .andWhere('g.capability = :capability', { capability })
        .andWhere(LIVE_PLATFORM_CAPABILITY_GRANT_SQL)
        .getOne();
      if (live) {
        throw new CapabilityAlreadyGrantedError(
          `'${capability}' is already granted to this user (grant ${live.id})`,
        );
      }

      const saved = await grants.save(
        grants.create({
          userId: user.id,
          capability,
          grantedBy: input.grantedBy,
          expiresAt,
          revokedBy: null,
          revokedAt: null,
          reason,
        }),
      );

      const invalidatedAt = new Date();
      await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        user.id,
        invalidatedAt,
        `Platform capability '${capability}' granted`,
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'platform-capability-changed',
        'role_permissions_changed',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);

      await this.auditLogService.log(
        {
          performedBy: input.grantedBy,
          action: 'PLATFORM_CAPABILITY_GRANTED',
          entityType: 'PlatformCapabilityGrant',
          entityId: saved.id,
          details: {
            userId: user.id,
            capability,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            reason,
          },
          severity: capability === 'break-glass' ? AuditLogSeverity.WARNING : AuditLogSeverity.INFO,
        },
        manager,
      );
      return { saved, intent };
    });

    await this.applyInvalidationImmediately(result.intent);
    this.logger.log(
      JSON.stringify({
        event: 'platform_capability_granted',
        userId: result.saved.userId,
        capability,
        grantedBy: input.grantedBy,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    );
    return result.saved;
  }

  async revoke(input: RevokePlatformCapabilityInput): Promise<PlatformCapabilityGrant> {
    const capability = this.validateCapability(input.capability);
    const reason = this.validateReason(input.reason);
    this.validateActor(input.revokedBy);

    const result = await this.dataSource.transaction(async (manager) => {
      const user = await lockUserForCredentialMutation(manager, this.userRepository, input.userId);
      if (!user) throw new NotFoundException(`User with ID "${input.userId}" not found`);

      const grants = manager.withRepository(this.grantRepository);
      const live = await grants.findOne({
        where: { userId: user.id, capability, revokedAt: IsNull() },
      });
      if (!live) {
        throw new CapabilityGrantNotFoundError(`No live '${capability}' grant for this user`);
      }
      live.revokedBy = input.revokedBy;
      live.revokedAt = new Date();
      const saved = await grants.save(live);

      const invalidatedAt = new Date();
      await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        user.id,
        invalidatedAt,
        `Platform capability '${capability}' revoked`,
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'platform-capability-changed',
        'role_permissions_changed',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);

      await this.auditLogService.log(
        {
          performedBy: input.revokedBy,
          action: 'PLATFORM_CAPABILITY_REVOKED',
          entityType: 'PlatformCapabilityGrant',
          entityId: saved.id,
          details: { userId: user.id, capability, reason },
          severity: AuditLogSeverity.INFO,
        },
        manager,
      );
      return { saved, intent };
    });

    await this.applyInvalidationImmediately(result.intent);
    this.logger.log(
      JSON.stringify({
        event: 'platform_capability_revoked',
        userId: result.saved.userId,
        capability,
        revokedBy: input.revokedBy,
      }),
    );
    return result.saved;
  }

  private validateCapability(value: string): PlatformCapability {
    if (!isPlatformCapability(value)) {
      throw new PlatformCapabilityPolicyError(
        'INVALID_CAPABILITY',
        `'${value}' is not a platform capability`,
      );
    }
    return value;
  }

  private validateReason(value: string): string {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      throw new PlatformCapabilityPolicyError(
        'VALIDATION_ERROR',
        `reason is required (1-${MAX_REASON_LENGTH} characters)`,
      );
    }
    return reason;
  }

  private validateActor(actorId: string): void {
    if (!UUID.test(actorId)) {
      throw new PlatformCapabilityPolicyError('VALIDATION_ERROR', 'actor id must be a UUID');
    }
  }

  private validateExpiry(
    capability: PlatformCapability,
    raw: string | undefined,
    now: Date,
  ): Date | null {
    if (raw === undefined) {
      if (capability === 'break-glass') {
        throw new PlatformCapabilityPolicyError(
          'EXPIRY_REQUIRED',
          "'break-glass' is time-boxed: expiresAt is required",
        );
      }
      return null;
    }
    const expiresAt = new Date(raw);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new PlatformCapabilityPolicyError('VALIDATION_ERROR', 'expiresAt must be ISO-8601');
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new PlatformCapabilityPolicyError('EXPIRY_IN_PAST', 'expiresAt must be in the future');
    }
    if (
      capability === 'break-glass' &&
      expiresAt.getTime() - now.getTime() > BREAK_GLASS_MAX_TTL_SECONDS * 1000
    ) {
      throw new PlatformCapabilityPolicyError(
        'EXPIRY_TOO_LONG',
        `'break-glass' expires within ${BREAK_GLASS_MAX_TTL_SECONDS / 3600} hours of the grant`,
      );
    }
    return expiresAt;
  }

  private async applyInvalidationImmediately(intent: UserTokenInvalidationIntent): Promise<void> {
    // The transaction already committed the durable invalidation event; a
    // Redis blip must not turn a committed grant into an apparent failure.
    // The outbox consumer replays the same max-only epoch.
    try {
      await this.durableUserTokenInvalidation.applyImmediately(intent);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'platform_capability_immediate_invalidation_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }
}
