import * as crypto from 'crypto';

import { Public } from '@aquaculture/backend-common/decorators';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { parseFrontendUrl } from '../../../config/frontend-url';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { User } from '../entities/user.entity';

@Public()
@Controller('internal')
export class InternalAuthController {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(ActionToken)
    private readonly actionTokenRepository: Repository<ActionToken>,
    private readonly configService: ConfigService,
  ) {
    // DEPLOY-HIGH-016: resolved once, at boot. Reading it per request meant a
    // misconfigured deployment surfaced as a wrong link in somebody's inbox
    // rather than as a service that refuses to start.
    this.frontendOrigin = parseFrontendUrl(this.configService);
  }

  private readonly frontendOrigin: string;

  @Get('users/:userId/pii')
  async getUserPii(
    @Param('userId') userId: string,
    @Req() request: TenantRequest,
  ): Promise<{ email: string; firstName?: string; lastName?: string }> {
    const tenantId = this.requireNotificationService(request);
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId) {
      throw new NotFoundException('User not found');
    }

    return {
      email: user.email,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
    };
  }

  @Get('tenants/:tenantId/info')
  async getTenantInfo(
    @Param('tenantId') tenantId: string,
    @Req() request: TenantRequest,
  ): Promise<{ name: string }> {
    this.requireNotificationService(request, tenantId);
    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return { name: tenant.name };
  }

  @Get('action-tokens/:actionTokenId/url')
  async getActionTokenUrl(
    @Param('actionTokenId') actionTokenId: string,
    @Req() request: TenantRequest,
  ): Promise<{ actionUrl: string }> {
    const tenantId = this.requireNotificationService(request);
    const actionToken = await this.actionTokenRepository.findOne({
      where: { id: actionTokenId, tenantId, status: ActionTokenStatus.ACTIVE },
    });

    if (actionToken) {
      if (!actionToken.isActive()) {
        throw new NotFoundException('Action token not found');
      }

      return {
        actionUrl: `${this.frontendOrigin}/${this.actionPath(actionToken.purpose)}/${actionToken.id}`,
      };
    }

    const user = await this.userRepository.findOne({
      where: [
        { tenantId, invitationToken: actionTokenId },
        { tenantId, passwordResetToken: actionTokenId },
      ],
    });

    if (!user) {
      throw new NotFoundException('Action token not found');
    }

    if (user.invitationToken === actionTokenId) {
      const rawToken = await this.rotateInvitationToken(user, actionTokenId);
      return { actionUrl: `${this.frontendOrigin}/accept-invitation/${rawToken}` };
    }

    if (user.passwordResetToken === actionTokenId) {
      const rawToken = await this.rotatePasswordResetToken(user);
      return { actionUrl: `${this.frontendOrigin}/reset-password/${rawToken}` };
    }

    throw new NotFoundException('Action token not found');
  }

  private requireNotificationService(
    request: TenantRequest,
    expectedTenantId?: string,
  ): string {
    const identity = request.verifiedIdentity;
    if (!identity || identity.serviceName !== 'notification-service') {
      throw new ForbiddenException('Internal notification service identity is required');
    }

    const tenantId = identity.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant-bound internal request is required');
    }
    if (expectedTenantId && tenantId !== expectedTenantId) {
      throw new ForbiddenException('Tenant binding does not match request path');
    }
    return tenantId;
  }

  private async rotateInvitationToken(
    user: User,
    currentTokenHash: string,
  ): Promise<string> {
    if (!user.tenantId) {
      throw new NotFoundException('Action token not found');
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = user.invitationExpiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    user.invitationToken = tokenHash;
    user.invitationExpiresAt = expiresAt;
    await this.userRepository.save(user);

    const invitation = await this.invitationRepository.findOne({
      where: {
        token: currentTokenHash,
        tenantId: user.tenantId,
      },
    });
    if (invitation) {
      invitation.token = tokenHash;
      invitation.status = InvitationStatus.PENDING;
      invitation.expiresAt = expiresAt;
      invitation.lastSentAt = new Date();
      invitation.sendCount += 1;
      await this.invitationRepository.save(invitation);
    }

    return rawToken;
  }

  private async rotatePasswordResetToken(user: User): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = this.hashToken(rawToken);
    user.passwordResetExpires = user.passwordResetExpires ?? new Date(Date.now() + 60 * 60 * 1000);
    await this.userRepository.save(user);
    return rawToken;
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private actionPath(purpose: ActionTokenPurpose): string {
    switch (purpose) {
      case ActionTokenPurpose.INVITATION:
        return 'accept-invitation';
      case ActionTokenPurpose.PASSWORD_RESET:
        return 'reset-password';
      default:
        throw new NotFoundException('Action token not found');
    }
  }

}
