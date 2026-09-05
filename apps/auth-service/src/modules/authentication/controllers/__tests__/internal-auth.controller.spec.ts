/**
 * InternalAuthController — the notification-service's window into auth-service
 * (SEC-HIGH-056). The action-token URL endpoint is where the emailed link is
 * minted; these tests pin that the link carries the ActionToken row id and
 * nothing else, that a token of another tenant or an inactive token is 404,
 * and that only notification-service with a tenant binding may ask.
 */
import type { TenantRequest, VerifiedServiceIdentity } from '@aquaculture/backend-common/types';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../../tenant/entities/tenant.entity';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../../entities/action-token.entity';
import { User } from '../../entities/user.entity';
import { ActionTokenResolver } from '../../services/action-token-resolver.service';
import { InternalAuthController } from '../internal-auth.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const ACTION_TOKEN_ID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';
const TOKEN_HASH = 'c'.repeat(64);

function identity(overrides: Partial<VerifiedServiceIdentity> = {}): VerifiedServiceIdentity {
  return {
    serviceName: 'notification-service',
    tenantId: TENANT_ID,
    effectiveTenantId: TENANT_ID,
    keyId: 'k1',
    audience: 'auth-service',
    nonce: 'n1',
    version: 'v2',
    ...overrides,
  };
}

function request(verifiedIdentity?: VerifiedServiceIdentity): TenantRequest {
  return { verifiedIdentity } as TenantRequest;
}

function activeToken(overrides: Partial<ActionToken> = {}): ActionToken {
  return Object.assign(new ActionToken(), {
    id: ACTION_TOKEN_ID,
    purpose: ActionTokenPurpose.INVITATION,
    tenantId: TENANT_ID,
    userId: '22222222-2222-4222-8222-222222222222',
    tokenHash: TOKEN_HASH,
    status: ActionTokenStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

describe('InternalAuthController', () => {
  const userRepository = { findOne: jest.fn() };
  const tenantRepository = { findOne: jest.fn() };
  const actionTokenRepository = { findOne: jest.fn() };
  let controller: InternalAuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [InternalAuthController],
      providers: [
        ActionTokenResolver,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
        { provide: getRepositoryToken(ActionToken), useValue: actionTokenRepository },
        {
          provide: ConfigService,
          useValue: new ConfigService({ FRONTEND_URL: 'https://app.example.com/' }),
        },
      ],
    }).compile();
    controller = module.get(InternalAuthController);
  });

  describe('GET internal/action-tokens/:id/url', () => {
    it('builds /accept-invitation/{actionToken.id} for an active tenant-bound invitation token', async () => {
      actionTokenRepository.findOne.mockResolvedValue(activeToken());

      const result = await controller.getActionTokenUrl(ACTION_TOKEN_ID, request(identity()));

      expect(result).toEqual({
        actionUrl: `https://app.example.com/accept-invitation/${ACTION_TOKEN_ID}`,
      });
      expect(actionTokenRepository.findOne).toHaveBeenCalledWith({
        where: { id: ACTION_TOKEN_ID, tenantId: TENANT_ID, status: ActionTokenStatus.ACTIVE },
      });
    });

    it('builds /reset-password/{actionToken.id} for a password-reset token', async () => {
      actionTokenRepository.findOne.mockResolvedValue(
        activeToken({ purpose: ActionTokenPurpose.PASSWORD_RESET }),
      );

      const result = await controller.getActionTokenUrl(ACTION_TOKEN_ID, request(identity()));

      expect(result.actionUrl).toBe(`https://app.example.com/reset-password/${ACTION_TOKEN_ID}`);
    });

    it('never emits the token hash or a raw secret in a URL', async () => {
      actionTokenRepository.findOne.mockResolvedValue(activeToken());

      const result = await controller.getActionTokenUrl(ACTION_TOKEN_ID, request(identity()));

      expect(result.actionUrl).not.toMatch(/[0-9a-f]{64}/);
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns 404 for an expired token instead of rotating a fresh secret', async () => {
      actionTokenRepository.findOne.mockResolvedValue(
        activeToken({ expiresAt: new Date(Date.now() - 1_000) }),
      );

      await expect(
        controller.getActionTokenUrl(ACTION_TOKEN_ID, request(identity())),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns 404 when the token belongs to another tenant (the lookup is tenant-bound)', async () => {
      actionTokenRepository.findOne.mockResolvedValue(null);

      await expect(
        controller.getActionTokenUrl(
          ACTION_TOKEN_ID,
          request(identity({ tenantId: OTHER_TENANT_ID })),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(actionTokenRepository.findOne).toHaveBeenCalledWith({
        where: { id: ACTION_TOKEN_ID, tenantId: OTHER_TENANT_ID, status: ActionTokenStatus.ACTIVE },
      });
    });

    it('rejects a caller that is not notification-service', async () => {
      await expect(
        controller.getActionTokenUrl(
          ACTION_TOKEN_ID,
          request(identity({ serviceName: 'farm-service' })),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(actionTokenRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unverified request', async () => {
      await expect(
        controller.getActionTokenUrl(ACTION_TOKEN_ID, request(undefined)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET internal/users/:id/pii', () => {
    it('serves PII only for a user of the caller-bound tenant', async () => {
      userRepository.findOne.mockResolvedValue(
        Object.assign(new User(), {
          id: 'u1',
          tenantId: TENANT_ID,
          email: 'a@example.com',
          firstName: 'Ada',
          lastName: null,
        }),
      );

      await expect(controller.getUserPii('u1', request(identity()))).resolves.toEqual({
        email: 'a@example.com',
        firstName: 'Ada',
        lastName: undefined,
      });
      await expect(
        controller.getUserPii('u1', request(identity({ tenantId: OTHER_TENANT_ID }))),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
