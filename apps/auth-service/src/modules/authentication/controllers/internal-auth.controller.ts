import { Public } from '@aquaculture/backend-common/decorators';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { requestContextStorage, getRequestContext } from '@aquaculture/backend-common/logging';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { Controller, ForbiddenException, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  InvalidEventTenantScopeError,
  PLATFORM_SCOPE,
  tenantScopeOf,
  type EventTenantScope,
} from '@platform/event-contracts';
import { IsNull, Repository } from 'typeorm';

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
    private readonly bypassRls: BypassRlsService,
  ) {
    // DEPLOY-HIGH-016: resolved once, at boot. Reading it per request meant a
    // misconfigured deployment surfaced as a wrong link in somebody's inbox
    // rather than as a service that refuses to start.
    this.frontendUrl = parseFrontendUrl(configService);
  }

  @Get('users/:userId/pii')
  async getUserPii(
    @Param('userId') userId: string,
    @Req() request: TenantRequest,
  ): Promise<{ email: string; firstName?: string; lastName?: string }> {
    const scope = this.requireNotificationService(request);
    const user = await this.userRepository.findOne({ where: { id: userId } });
    // SEC-HIGH-159: a tenant-bound caller sees only its tenant's users; a
    // platform-scoped caller sees only platform principals (super admins with
    // no tenant). Neither can read across the boundary.
    const visible =
      user !== null &&
      (scope.kind === 'tenant'
        ? user.tenantId === scope.tenantId
        : (user.tenantId === null || user.tenantId === undefined) && user.isSuperAdmin());
    if (!user || !visible) {
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
    // A platform-scoped call has no tenant to describe; the binding must match.
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
    const scope = this.requireNotificationService(request);
    // SEC-HIGH-158: the link carries the ActionToken row id and nothing else.
    // The legacy branch that treated this id as a token HASH and rotated a
    // fresh raw token into the URL is gone: every producer now mints an
    // ActionToken row (tenant provisioning, admin invite, createUser, password
    // reset), and the resolver on the redemption side reads that id back.
    // SEC-HIGH-159: the lookup is bound to the caller's scope — a tenant's
    // rows for a tenant-bound caller, NULL-tenant rows (a super admin's
    // reset) for a platform-scoped caller. A token can never be resolved
    // from the wrong side.
    const lookup = (): Promise<ActionToken | null> => this.actionTokenRepository.findOne({
      where: {
        id: actionTokenId,
        tenantId: scope.kind === 'tenant' ? scope.tenantId : IsNull(),
        status: ActionTokenStatus.ACTIVE,
      },
    });
    // The HMAC-verified notification scope must reach the connection before
    // checkout. A NULL-tenant action cannot satisfy tenant RLS without the
    // explicitly authorized platform frame; the query still binds tenantId.
    const actionToken = await requestContextStorage.run({ ...getRequestContext(),
      tenantId: scope.kind === 'tenant' ? scope.tenantId : undefined, bypassRls: false }, () =>
      scope.kind === 'platform'
        ? this.bypassRls.withBypass('auth-service:notification-platform-action-url', lookup)
        : lookup());

    if (!actionToken || !actionToken.isActive()) {
      throw new NotFoundException('Action token not found');
    }

    return {
      actionUrl: this.actionTokenResolver.buildActionUrl(this.frontendUrl, actionToken),
    };
  }

  /**
   * The caller's tenancy scope, from the HMAC-verified internal identity.
   *
   * SEC-HIGH-159: the signed identity binds either a tenant id or the explicit
   * non-tenant opt-out (`tenantId: ''`, see signedFetch). The empty binding is
   * the PLATFORM scope — the notification service resolving a super admin's
   * recovery e-mail — not a missing binding. Anything that is neither a UUID
   * nor empty is refused: the signature layer never admits it, so seeing it
   * here means a forged or corrupted identity. When the route names a tenant
   * (`expectedTenantId`) the caller must be bound to exactly that tenant; a
   * platform-scoped caller has no tenant to describe.
   */
  private requireNotificationService(
    request: TenantRequest,
    expectedTenantId?: string,
  ): EventTenantScope {
    const identity = request.verifiedIdentity;
    if (!identity || identity.serviceName !== 'notification-service') {
      throw new ForbiddenException('Internal notification service identity is required');
    }

    let scope: EventTenantScope;
    try {
      scope = identity.tenantId === '' ? PLATFORM_SCOPE : tenantScopeOf(identity.tenantId);
    } catch (error) {
      if (error instanceof InvalidEventTenantScopeError) {
        throw new ForbiddenException('Tenant binding is not a tenant id');
      }
      throw error;
    }

    if (expectedTenantId !== undefined) {
      if (scope.kind !== 'tenant') {
        throw new ForbiddenException('Tenant-bound internal request is required');
      }
      if (scope.tenantId !== expectedTenantId) {
        throw new ForbiddenException('Tenant binding does not match request path');
      }
    }
    return scope;
  }
}
