import { randomUUID } from 'node:crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { TOKEN_BLACKLIST, USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { ActionTokenResolver } from '../services/action-token-resolver.service';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

describe('credential action completion', () => {
  async function setup(purpose: ActionTokenPurpose): Promise<{
    service: AuthenticationService;
    action: ActionToken;
    user: User;
    outbox: { enqueue: jest.Mock };
    tokens: { generateTokens: jest.Mock; generateTokensInContext: jest.Mock };
    mfa: { isMfaAvailable: jest.Mock; generateMfaSetupToken: jest.Mock };
    invalidation: { enqueue: jest.Mock; applyImmediately: jest.Mock };
    update: jest.SpyInstance;
    remove: jest.SpyInstance;
  }> {
    const tenant = Object.assign(new Tenant(), {
      id: randomUUID(),
      status: TenantStatus.SUSPENDED,
      enforceMfa: true,
    });
    const user = Object.assign(new User(), {
      id: randomUUID(),
      email: 'action@example.test',
      role: Role.MODULE_USER,
      tenantId: tenant.id,
      isActive: true,
      credentialVersion: 4,
      accessTokenInvalidBeforeEpochSeconds: 0,
      invitationToken: 'stored-action-hash',
      passwordResetToken: 'stored-action-hash',
      passwordResetExpires: new Date(Date.now() + 60_000),
    });
    const action = Object.assign(new ActionToken(), {
      id: randomUUID(),
      userId: user.id,
      tenantId: tenant.id,
      purpose,
      tokenHash: 'stored-action-hash',
      status: ActionTokenStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const invitation = Object.assign(new Invitation(), {
      id: randomUUID(),
      userId: user.id,
      tenantId: tenant.id,
      token: action.tokenHash,
      email: user.email,
      role: user.role,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const source = new DataSource({ type: 'postgres' });
    const runner = source.createQueryRunner();
    jest.replaceProperty(runner, 'isTransactionActive', true);
    const manager = runner.manager;
    jest.spyOn(manager, 'findOne').mockImplementation(async (entity) => {
      if (entity === User) return user;
      if (entity === Tenant) return tenant;
      if (entity === ActionToken) return action;
      if (entity === Invitation) return invitation;
      throw new Error('Unexpected action lookup');
    });
    const update = jest
      .spyOn(manager, 'update')
      .mockImplementation(async (entity, _criteria, values) => {
        if (entity === ActionToken) Object.assign(action, values);
        return { affected: 1, raw: [], generatedMaps: [] };
      });
    const remove = jest.spyOn(manager, 'delete').mockResolvedValue({ affected: 1, raw: [] });
    const tokens = { generateTokens: jest.fn(), generateTokensInContext: jest.fn() };
    const mfa = {
      isMfaAvailable: jest.fn().mockReturnValue(false),
      generateMfaSetupToken: jest.fn(),
    };
    const invalidation = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      applyImmediately: jest.fn(),
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        ActionTokenResolver,
        ...[User, RefreshToken, ActionToken, Tenant, WebAuthnCredential].map((entity) => ({
          provide: getRepositoryToken(entity),
          useValue: {},
        })),
        {
          provide: getRepositoryToken(Invitation),
          useValue: { findOne: jest.fn().mockResolvedValue(invitation) },
        },
        {
          provide: DataSource,
          useValue: {
            manager,
            transaction: jest.fn(async (operation: (active: typeof manager) => Promise<unknown>) =>
              operation(manager),
            ),
          },
        },
        { provide: JwtService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback?: unknown): unknown => fallback },
        },
        { provide: BestEffortEventPublisher, useValue: { publish: jest.fn() } },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: TokenService, useValue: tokens },
        { provide: MfaService, useValue: mfa },
        { provide: DurableUserTokenInvalidationService, useValue: invalidation },
        { provide: DurableAccessTokenInvalidationService, useValue: {} },
        { provide: OutboxPublisher, useValue: outbox },
        { provide: TOKEN_BLACKLIST, useValue: {} },
        { provide: USER_TOKEN_REVOCATION, useValue: {} },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_reason: string, operation: () => Promise<T>): Promise<T> =>
              operation(),
          },
        },
      ],
    }).compile();
    return {
      service: module.get(AuthenticationService),
      action,
      user,
      outbox,
      tokens,
      mfa,
      invalidation,
      update,
      remove,
    };
  }

  it.each([ActionTokenPurpose.INVITATION, ActionTokenPurpose.PASSWORD_RESET])(
    'completes %s without new-session admission, Redis application or MFA availability',
    async (purpose) => {
      const test = await setup(purpose);
      const result =
        purpose === ActionTokenPurpose.INVITATION
          ? await test.service.acceptInvitation(test.action.id, 'New-Credential-42!')
          : await test.service.resetPassword(test.action.id, 'New-Credential-42!');
      expect(result).toEqual({ success: true, loginRequired: true });
      expect(test.action.status).toBe(ActionTokenStatus.CONSUMED);
      expect(test.invalidation.enqueue).toHaveBeenCalledTimes(1);
      expect(test.invalidation.applyImmediately).not.toHaveBeenCalled();
      expect(test.tokens.generateTokens).not.toHaveBeenCalled();
      expect(test.tokens.generateTokensInContext).not.toHaveBeenCalled();
      expect(test.mfa.isMfaAvailable).not.toHaveBeenCalled();
      expect(test.outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(test.update).toHaveBeenCalledWith(
        RefreshToken,
        { userId: test.user.id },
        expect.objectContaining({ isRevoked: true }),
      );
      if (purpose === ActionTokenPurpose.PASSWORD_RESET) {
        expect(test.remove).toHaveBeenCalledWith(WebAuthnCredential, { userId: test.user.id });
      }
    },
  );

  it('validates an emailed opaque invitation id and rejects it after consumption', async () => {
    const test = await setup(ActionTokenPurpose.INVITATION);
    expect(await test.service.validateInvitation(test.action.id)).toMatchObject({
      valid: true,
      email: test.user.email,
    });
    await test.service.acceptInvitation(test.action.id, 'New-Credential-42!');
    expect(await test.service.validateInvitation(test.action.id)).toEqual({ valid: false });
    await expect(
      test.service.acceptInvitation(test.action.id, 'Another-Credential-73!'),
    ).rejects.toThrow('Invalid or expired');
  });
});
