import { Public } from '@aquaculture/backend-common/decorators';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { Controller, ForbiddenException, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { parseFrontendUrl } from '../../../config/frontend-url';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken, ActionTokenStatus } from '../entities/action-token.entity';
import { User } from '../entities/user.entity';
import { ActionTokenResolver } from '../services/action-token-resolver.service';

@Public()
@Controller('internal')
export class InternalAuthController {
  /**
   * DEPLOY-HIGH-016: parsed once at construction so a deployment without a
   * valid FRONTEND_URL fails at boot, not at the first e-mail.
   */
  private readonly frontendUrl: string;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(ActionToken)
    private readonly actionTokenRepository: Repository<ActionToken>,
    configService: ConfigService,
    private readonly actionTokenResolver: ActionTokenResolver,
  ) {
    this.frontendUrl = parseFrontendUrl(configService);
  }

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
    // SEC-HIGH-056: the link carries the ActionToken row id and nothing else.
    // The legacy branch that treated this id as a token HASH and rotated a
    // fresh raw token into the URL is gone: every producer now mints an
    // ActionToken row (tenant provisioning, admin invite, createUser, password
    // reset), and the resolver on the redemption side reads that id back.
    const actionToken = await this.actionTokenRepository.findOne({
      where: { id: actionTokenId, tenantId, status: ActionTokenStatus.ACTIVE },
    });

    if (!actionToken || !actionToken.isActive()) {
      throw new NotFoundException('Action token not found');
    }

    return {
      actionUrl: this.actionTokenResolver.buildActionUrl(this.frontendUrl, actionToken),
    };
  }

  private requireNotificationService(request: TenantRequest, expectedTenantId?: string): string {
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
}
