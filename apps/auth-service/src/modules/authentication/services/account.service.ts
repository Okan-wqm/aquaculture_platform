/* eslint-disable aquaculture/no-direct-event-publish -- Account events are non-transactional notifications; audit log is the persistent account trail. */
import {
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  ISessionManager,
  ITokenBlacklist,
  passwordPolicyViolation,
} from '@aquaculture/backend-common/security';
import { BadRequestException, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import {
  ChangeMyPasswordInput,
  ChangeMyPasswordResponse,
  MySecuritySettings,
  UpdateMyProfileInput,
} from '../dto/account.dto';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';

import { MfaService } from './mfa.service';
import { parseExpiresIn } from './token.service';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly mfaService: MfaService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
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

    const savedUser = await this.userRepository.save(user);

    await Promise.allSettled([
      this.auditAccountEvent('USER_PROFILE_UPDATED', savedUser),
      this.eventBus.publish({
        ...createBaseEvent('UserProfileUpdated', savedUser.tenantId ?? 'system', {
          aggregateId: savedUser.id,
          aggregateType: 'User',
          userId: savedUser.id,
        }),
      }),
    ]);

    return savedUser;
  }

  async changeMyPassword(userId: string, input: ChangeMyPasswordInput): Promise<ChangeMyPasswordResponse> {
    const user = await this.findUserOrFail(userId);

    const currentPasswordMatches = await user.validatePassword(input.currentPassword);
    if (!currentPasswordMatches) {
      await this.auditAccountEvent('PASSWORD_CHANGE_FAILED', user, false, 'invalid_current_password');
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordPolicyError = passwordPolicyViolation(input.newPassword);
    if (passwordPolicyError) {
      await this.auditAccountEvent('PASSWORD_CHANGE_FAILED', user, false, 'password_policy');
      throw new BadRequestException(passwordPolicyError);
    }

    user.password = input.newPassword;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.userRepository.save(user);

    await this.revokeCredentialsAfterPasswordChange(user.id);

    await Promise.allSettled([
      this.auditAccountEvent('PASSWORD_CHANGED', user),
      this.eventBus.publish({
        ...createBaseEvent('UserPasswordChanged', user.tenantId ?? 'system', {
          aggregateId: user.id,
          aggregateType: 'User',
          userId: user.id,
        }),
      }),
    ]);

    this.logger.log(`Password changed: userId=${user.id}`);

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

  private async revokeCredentialsAfterPasswordChange(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'Password changed' },
    );

    if (!this.tokenBlacklist) {
      throw new Error('TOKEN_BLACKLIST provider is required for password-change revocation');
    }

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
    const expiresInSeconds = parseExpiresIn(expiresIn);
    const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);
    await this.tokenBlacklist.blacklistUserTokens(userId, expiryDate, 'password_change');

    if (!this.sessionManager) {
      throw new Error('SESSION_MANAGER provider is required for password-change revocation');
    }

    await this.sessionManager.revokeAllSessions(userId);
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
