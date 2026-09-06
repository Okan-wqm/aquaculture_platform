import { hashPassword } from '@aquaculture/backend-common/auth';
import { LockedAuthContext, snapshotCredentialProof } from './credential-state';
import { Role } from '@aquaculture/backend-common/decorators';
import { SESSION_MANAGER, ISessionManager } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createBaseEvent } from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import {
  ChangeMyPasswordInput,
  ChangeMyPasswordResponse,
  MySecuritySettings,
  UpdateMyProfileInput,
} from '../dto/account.dto';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';

import { MfaService } from './mfa.service';
import {
  DurableUserTokenInvalidationService,
  type UserTokenInvalidationIntent,
} from './durable-user-token-invalidation.service';
import {
  type PostCommitSecurityEffect,
  settlePostCommitSecurityEffects,
} from './post-commit-security-effects';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly mfaService: MfaService,
    // DATA-HIGH-001: account events are audit-log-backed notifications (the
    // audit log is the durable source-of-truth) and can originate from a
    // platform-level SUPER_ADMIN (tenantId NULL, which the durable outbox
    // cannot key). They route through the allowlisted best-effort path
    // instead of the raw event bus.
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly durableUserTokenInvalidation: DurableUserTokenInvalidationService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
  ) {}

  async updateMyProfile(
    userId: string,
    input: UpdateMyProfileInput,
    options: { email?: string } = {},
  ): Promise<User> {
    const user = await this.findUserOrFail(userId);

    if (options.email && options.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new BadRequestException('Email changes require a verified email workflow');
    }

    if (input.firstName !== undefined) {
      const firstName = input.firstName.trim();
      if (!firstName) {
        throw new BadRequestException('First name is required');
      }
      user.firstName = firstName;
    }

    if (input.lastName !== undefined) {
      const lastName = input.lastName.trim();
      if (!lastName) {
        throw new BadRequestException('Last name is required');
      }
      user.lastName = lastName;
    }

    await this.userRepository.update({ id: userId }, {
      ...(input.firstName !== undefined ? { firstName: user.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: user.lastName } : {}),
    });
    const savedUser = await this.findUserOrFail(userId);

    await Promise.allSettled([
      this.auditAccountEvent('USER_PROFILE_UPDATED', savedUser),
      this.bestEffort.publish(
        createBaseEvent('UserProfileUpdated', savedUser.tenantId ?? 'system', {
          aggregateId: savedUser.id,
          aggregateType: 'User',
          userId: savedUser.id,
        }),
      ),
    ]);

    return savedUser;
  }

  async changeMyPassword(
    userId: string,
    input: ChangeMyPasswordInput,
  ): Promise<ChangeMyPasswordResponse> {
    const authenticated = await this.findUserOrFail(userId);
    const proof = snapshotCredentialProof(authenticated);
    if (!await authenticated.validatePassword(input.currentPassword)) {
      await this.auditAccountEvent('PASSWORD_CHANGE_FAILED', authenticated, false, 'invalid_current_password');
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const context = await LockedAuthContext.lock(manager, proof);
      const user = context.user;
      const refreshTokenRepository = manager.withRepository(this.refreshTokenRepository);
      await manager.update(User, { id: userId }, {
        password: passwordHash, failedLoginAttempts: 0, lockedUntil: null,
      });

      const invalidatedAt = new Date();
      await refreshTokenRepository.update(
        { userId },
        {
          isRevoked: true,
          revokedAt: invalidatedAt,
          revokedReason: 'Password changed',
        },
      );
      const intent: UserTokenInvalidationIntent = {
        userId,
        tenantId: this.invalidationTenantForUser(user),
        invalidatedAt,
        reason: 'password_changed',
        idempotencyKey: `password-change:${userId}:${Math.floor(invalidatedAt.getTime() / 1000)}`,
      };
      await this.durableUserTokenInvalidation.enqueue(manager, intent);
      await this.auditLogService.log({ tenantId: user.tenantId ?? undefined, performedBy: user.id,
        action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id }, manager);
      return { user, intent };
    });

    const postCommitEffects: PostCommitSecurityEffect[] = [
      {
        type: 'user_token_invalidation',
        apply: () => this.durableUserTokenInvalidation.applyImmediately(transactionResult.intent),
      },
    ];
    const sessionManager = this.sessionManager;
    if (sessionManager) {
      postCommitEffects.push({
        type: 'session_revocation',
        apply: () => sessionManager.revokeAllSessions(userId),
      });
    }
    await settlePostCommitSecurityEffects({
      logger: this.logger,
      operation: 'password_change',
      effects: postCommitEffects,
    });
    const { user } = transactionResult;

    await Promise.allSettled([
      this.bestEffort.publish(
        createBaseEvent('UserPasswordChanged', user.tenantId ?? 'system', {
          aggregateId: user.id,
          aggregateType: 'User',
          userId: user.id,
        }),
      ),
    ]);

    this.logger.log(JSON.stringify({ event: 'password_changed' }));

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }

  async getMySecuritySettings(userId: string): Promise<MySecuritySettings> {
    const user = await this.findUserOrFail(userId);
    const mfaAvailable = this.mfaService.isMfaAvailable();

    return {
      mfaEnabled: user.mfaEnabled,
      mfaAvailable,
      mfaUnavailableReason: mfaAvailable ? null : this.mfaService.getMfaUnavailableReason(),
    };
  }

  private async findUserOrFail(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  private invalidationTenantForUser(user: User): string | null {
    if (user.tenantId) {
      return user.tenantId;
    }
    if (user.role === Role.SUPER_ADMIN) {
      return null;
    }
    throw new ForbiddenException('Tenant-scoped user has no tenant identity');
  }

  private async auditAccountEvent(
    action: string,
    user: User,
    success = true,
    reason?: string,
  ): Promise<void> {
    await this.auditLogService.log({
      tenantId: user.tenantId || undefined,
      performedBy: user.id,
      action,
      entityType: 'User',
      entityId: user.id,
      details: {
        success,
        reason,
        timestamp: new Date().toISOString(),
      },
      severity: success ? AuditLogSeverity.INFO : AuditLogSeverity.WARNING,
    });
  }
}
