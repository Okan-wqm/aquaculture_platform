import { BypassRlsService } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Role } from '@aquaculture/backend-common/decorators';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../../audit/audit-log.service';
import { RefreshToken } from '../../../authentication/entities/refresh-token.entity';
import { User } from '../../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { PlatformCapabilityGrant } from '../../entities/platform-capability-grant.entity';
import {
  CapabilityAlreadyGrantedError,
  CapabilityGrantNotFoundError,
  NotPlatformAdminError,
  PlatformCapabilityPolicyError,
  PlatformCapabilityService,
} from '../platform-capability.service';

/**
 * ADR-0016 — the single writer of auth.platform_capability_grants.
 *
 * These tests pin the policy the ADR fixes: only an active SUPER_ADMIN holds
 * a capability; break-glass is time-boxed and dual-controlled; a capability
 * is live at most once; and every change revokes the target's sessions and
 * leaves an audit row inside the same transaction.
 */
describe('PlatformCapabilityService', () => {
  const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const GRANTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const NOW = new Date('2026-09-05T10:00:00.000Z');

  const lockedUser = { id: ADMIN, role: Role.SUPER_ADMIN, isActive: true, tenantId: null };

  /** The transaction-scoped repository doubles: `withRepository` hands back the same double. */
  const grantRepository = {
    create: jest.fn((row: Partial<PlatformCapabilityGrant>) => row),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const userRepository = { findOne: jest.fn() };
  const refreshTokenRepository = { createQueryBuilder: jest.fn(), update: jest.fn() };
  const auditLogService = { log: jest.fn().mockResolvedValue(undefined) };
  const durableInvalidation = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    applyImmediately: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    withRepository: jest.fn((repository: object) => repository),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const bypassRls = {
    withBypass: jest.fn((_operation: string, work: () => Promise<unknown>) => work()),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) => work(manager)),
  };

  let service: PlatformCapabilityService;
  let liveGrant: object | null;

  interface Chain {
    select: () => Chain;
    where: () => Chain;
    andWhere: () => Chain;
    orderBy: () => Chain;
    setLock: () => Chain;
    getMany: () => Promise<unknown[]>;
    getRawMany: () => Promise<unknown[]>;
    getOne: () => Promise<object | null>;
  }

  /** A minimal query-builder chain; `getOne` answers the "already live?" pre-check. */
  const queryBuilder = (): Chain => {
    const chain: Chain = {
      select: () => chain,
      where: () => chain,
      andWhere: () => chain,
      orderBy: () => chain,
      setLock: () => chain,
      getMany: () => Promise.resolve([]),
      getRawMany: () => Promise.resolve([]),
      getOne: () => Promise.resolve(liveGrant),
    };
    return chain;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    liveGrant = null;
    grantRepository.createQueryBuilder.mockImplementation(queryBuilder);
    grantRepository.save.mockImplementation((row: Partial<PlatformCapabilityGrant>) =>
      Promise.resolve({ id: 'grant-1', grantedAt: NOW, ...row }),
    );
    userRepository.findOne.mockResolvedValue(lockedUser);
    refreshTokenRepository.createQueryBuilder.mockImplementation(queryBuilder);
    refreshTokenRepository.update.mockResolvedValue({ affected: 2 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformCapabilityService,
        { provide: getRepositoryToken(PlatformCapabilityGrant), useValue: grantRepository },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: DurableUserTokenInvalidationService, useValue: durableInvalidation },
        { provide: BypassRlsService, useValue: bypassRls },
      ],
    }).compile();
    service = module.get(PlatformCapabilityService);
  });

  describe('grant', () => {
    it('writes a standing grant, revokes the sessions and audits inside the transaction', async () => {
      const grant = await service.grant(
        { userId: ADMIN, capability: 'billing-ops', grantedBy: GRANTOR, reason: 'OPS-12' },
        NOW,
      );

      expect(grant).toMatchObject({
        userId: ADMIN,
        capability: 'billing-ops',
        grantedBy: GRANTOR,
        expiresAt: null,
        reason: 'OPS-12',
      });
      // Session revocation + durable epoch advance run under the same manager.
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: ADMIN, isRevoked: false },
        expect.objectContaining({ isRevoked: true }),
      );
      expect(durableInvalidation.enqueue).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ userId: ADMIN, reason: 'role_permissions_changed' }),
      );
      expect(durableInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          performedBy: GRANTOR,
          action: 'PLATFORM_CAPABILITY_GRANTED',
          entityType: 'PlatformCapabilityGrant',
          details: expect.objectContaining({ userId: ADMIN, capability: 'billing-ops' }),
        }),
        manager,
      );
    });

    it('refuses a capability outside the closed enum', async () => {
      await expect(
        service.grant({ userId: ADMIN, capability: 'root', grantedBy: GRANTOR, reason: 'x' }, NOW),
      ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses a target that is not an active SUPER_ADMIN', async () => {
      userRepository.findOne.mockResolvedValue({ ...lockedUser, role: Role.TENANT_ADMIN });
      await expect(
        service.grant(
          { userId: ADMIN, capability: 'support-ops', grantedBy: GRANTOR, reason: 'x' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(NotPlatformAdminError);

      userRepository.findOne.mockResolvedValue({ ...lockedUser, isActive: false });
      await expect(
        service.grant(
          { userId: ADMIN, capability: 'support-ops', grantedBy: GRANTOR, reason: 'x' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(NotPlatformAdminError);
      expect(grantRepository.save).not.toHaveBeenCalled();
    });

    it('refuses an unknown user', async () => {
      userRepository.findOne.mockResolvedValue(null);
      await expect(
        service.grant(
          { userId: ADMIN, capability: 'support-ops', grantedBy: GRANTOR, reason: 'x' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('holds a capability live at most once', async () => {
      liveGrant = { id: 'grant-0' };
      await expect(
        service.grant(
          { userId: ADMIN, capability: 'support-ops', grantedBy: GRANTOR, reason: 'x' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(CapabilityAlreadyGrantedError);
      expect(grantRepository.save).not.toHaveBeenCalled();
    });

    describe('break-glass', () => {
      it('is dual-controlled: the grantor cannot be the target', async () => {
        await expect(
          service.grant(
            {
              userId: ADMIN,
              capability: 'break-glass',
              grantedBy: ADMIN,
              expiresAt: '2026-09-05T11:00:00.000Z',
              reason: 'INC-7',
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: 'SELF_GRANT_FORBIDDEN' });
      });

      it('requires an expiry', async () => {
        await expect(
          service.grant(
            { userId: ADMIN, capability: 'break-glass', grantedBy: GRANTOR, reason: 'INC-7' },
            NOW,
          ),
        ).rejects.toMatchObject({ code: 'EXPIRY_REQUIRED' });
      });

      it('caps the expiry at four hours from the grant', async () => {
        await expect(
          service.grant(
            {
              userId: ADMIN,
              capability: 'break-glass',
              grantedBy: GRANTOR,
              expiresAt: '2026-09-05T14:00:01.000Z',
              reason: 'INC-7',
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: 'EXPIRY_TOO_LONG' });

        const grant = await service.grant(
          {
            userId: ADMIN,
            capability: 'break-glass',
            grantedBy: GRANTOR,
            expiresAt: '2026-09-05T14:00:00.000Z',
            reason: 'INC-7',
          },
          NOW,
        );
        expect(grant.expiresAt).toEqual(new Date('2026-09-05T14:00:00.000Z'));
        expect(auditLogService.log).toHaveBeenCalledWith(
          expect.objectContaining({ severity: 'warning' }),
          manager,
        );
      });

      it('refuses an expiry in the past or unparseable', async () => {
        await expect(
          service.grant(
            {
              userId: ADMIN,
              capability: 'break-glass',
              grantedBy: GRANTOR,
              expiresAt: '2026-09-05T09:00:00.000Z',
              reason: 'INC-7',
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: 'EXPIRY_IN_PAST' });
        await expect(
          service.grant(
            {
              userId: ADMIN,
              capability: 'break-glass',
              grantedBy: GRANTOR,
              expiresAt: 'tomorrow',
              reason: 'INC-7',
            },
            NOW,
          ),
        ).rejects.toBeInstanceOf(PlatformCapabilityPolicyError);
      });
    });

    it('requires a reason', async () => {
      await expect(
        service.grant(
          { userId: ADMIN, capability: 'billing-ops', grantedBy: GRANTOR, reason: '  ' },
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('revoke', () => {
    it('closes the live row, revokes the sessions and audits', async () => {
      grantRepository.findOne.mockResolvedValue({
        id: 'grant-1',
        userId: ADMIN,
        capability: 'billing-ops',
        grantedBy: GRANTOR,
        grantedAt: NOW,
        expiresAt: null,
        revokedBy: null,
        revokedAt: null,
        reason: 'OPS-12',
      });

      const revoked = await service.revoke({
        userId: ADMIN,
        capability: 'billing-ops',
        revokedBy: GRANTOR,
        reason: 'rotation',
      });

      expect(revoked.revokedBy).toBe(GRANTOR);
      expect(revoked.revokedAt).toBeInstanceOf(Date);
      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
      expect(durableInvalidation.enqueue).toHaveBeenCalledTimes(1);
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PLATFORM_CAPABILITY_REVOKED', performedBy: GRANTOR }),
        manager,
      );
    });

    it('is a typed not-found when nothing is live', async () => {
      grantRepository.findOne.mockResolvedValue(null);
      await expect(
        service.revoke({
          userId: ADMIN,
          capability: 'billing-ops',
          revokedBy: GRANTOR,
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(CapabilityGrantNotFoundError);
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });
  });

  it('a Redis blip after commit is logged, never turned into a failed grant', async () => {
    durableInvalidation.applyImmediately.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      service.grant(
        { userId: ADMIN, capability: 'billing-ops', grantedBy: GRANTOR, reason: 'x' },
        NOW,
      ),
    ).resolves.toMatchObject({ capability: 'billing-ops' });
  });
  describe('credential-writer context (auth-tenant-context-ssot)', () => {
    it('runs a platform actor (no home tenant) under the audit-logged RLS bypass', async () => {
      await service.grant({
        userId: ADMIN,
        capability: 'billing-ops',
        grantedBy: GRANTOR,
        reason: 'on-call rotation',
      });

      expect(bypassRls.withBypass).toHaveBeenCalledWith(
        'auth-service:platform-capability-credentials',
        expect.any(Function),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('binds the target home tenant inside the transaction instead of bypassing', async () => {
      const homeTenant = '6b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      userRepository.findOne.mockResolvedValue({ ...lockedUser, tenantId: homeTenant });

      await service.grant({
        userId: ADMIN,
        capability: 'billing-ops',
        grantedBy: GRANTOR,
        reason: 'on-call rotation',
      });

      expect(bypassRls.withBypass).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('set_config'),
        expect.arrayContaining([homeTenant]),
      );
    });
  });
});
