import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getMetadataStorage } from 'class-validator';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../authentication/entities/user-site-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../authentication/services/durable-user-token-invalidation.service';
import { Module } from '../../system-module/entities/module.entity';
import { UpdateTenantSecurityPolicyInput } from '../dto/tenant-policy.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant } from '../entities/tenant.entity';
import { FarmSiteAssignmentValidator } from '../services/farm-site-assignment-validator.service';
import { TenantAdminService } from '../services/tenant-admin.service';

/**
 * ADR-046 — tenant auth-security policy (ADMIN-HIGH-010 / ADMIN-HIGH-014).
 *
 * London-school: every collaborator is a double, so these specs assert the
 * SERVICE's contract — what it writes, what it terminates, what it audits —
 * and never TypeORM's behaviour.
 */
describe('TenantAdminService — tenant auth-security policy (ADR-046)', () => {
  const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const buildTenant = (overrides: Partial<Tenant>): Tenant =>
    Object.assign(new Tenant(), { id: TENANT_ID, name: 'Acme', ...overrides });

  const buildUser = (overrides: Partial<User>): User =>
    Object.assign(new User(), { id: ADMIN_ID, email: 'admin@example.com', ...overrides });

  interface Harness {
    service: TenantAdminService;
    tenantUpdate: jest.Mock;
    auditLog: jest.Mock;
    terminatedUserIds: string[];
    applyImmediately: jest.Mock;
  }

  const buildHarness = async (
    tenant: Tenant | null,
    candidateIds: string[] = [],
  ): Promise<Harness> => {
    const tenantUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const applyImmediately = jest.fn().mockResolvedValue(undefined);
    const terminatedUserIds: string[] = [];

    // The candidate query is a builder chain ending in getRawMany(); the
    // NOT EXISTS sub-builder is threaded through the same object.
    const candidateQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      subQuery: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      getQuery: jest.fn().mockReturnValue('(SELECT 1)'),
      getRawMany: jest.fn().mockResolvedValue(candidateIds.map((id) => ({ id }))),
    };

    const userRepository = {
      findOne: jest.fn().mockResolvedValue(buildUser({})),
      createQueryBuilder: jest.fn().mockReturnValue(candidateQueryBuilder),
    };

    const refreshTokenQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const refreshTokenRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(refreshTokenQueryBuilder),
    };

    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === refreshTokenRepository) {
          return refreshTokenRepository;
        }
        return {
          findOne: jest.fn((options: { where: { id: string } }) =>
            Promise.resolve(buildUser({ id: options.where.id, tenantId: TENANT_ID })),
          ),
        };
      }),
    };

    const dataSource = {
      transaction: jest.fn((runner: (m: typeof manager) => Promise<unknown>) => runner(manager)),
    };

    const durableUserTokenInvalidation = {
      enqueue: jest.fn((_manager: unknown, intent: { userId: string }) => {
        terminatedUserIds.push(intent.userId);
        return Promise.resolve();
      }),
      applyImmediately,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantAdminService,
        {
          provide: getRepositoryToken(Tenant),
          useValue: { findOne: jest.fn().mockResolvedValue(tenant), update: tenantUpdate },
        },
        { provide: getRepositoryToken(TenantModule), useValue: {} },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: {} },
        { provide: getRepositoryToken(UserSiteAssignment), useValue: {} },
        { provide: getRepositoryToken(Module), useValue: {} },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditLogService, useValue: { log: auditLog } },
        { provide: FarmSiteAssignmentValidator, useValue: {} },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: durableUserTokenInvalidation,
        },
      ],
    }).compile();

    return {
      service: module.get<TenantAdminService>(TenantAdminService),
      tenantUpdate,
      auditLog,
      terminatedUserIds,
      applyImmediately,
    };
  };

  describe('getSecurityPolicy', () => {
    it('collapses a NULL enforce_mfa to its enforced meaning (false)', async () => {
      const { service } = await buildHarness(
        buildTenant({ enforceMfa: null, sessionTimeoutMinutes: null }),
      );

      await expect(service.getSecurityPolicy(TENANT_ID)).resolves.toEqual({
        enforceMfa: false,
        sessionTimeoutMinutes: null,
      });
    });

    it('returns the stored policy verbatim when set', async () => {
      const { service } = await buildHarness(
        buildTenant({ enforceMfa: true, sessionTimeoutMinutes: 30 }),
      );

      await expect(service.getSecurityPolicy(TENANT_ID)).resolves.toEqual({
        enforceMfa: true,
        sessionTimeoutMinutes: 30,
      });
    });

    it('404s on an unknown tenant instead of synthesizing a default', async () => {
      const { service } = await buildHarness(null);
      await expect(service.getSecurityPolicy(TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateSecurityPolicy — write shape', () => {
    it('writes ONLY the two policy columns (never a whole-entity save)', async () => {
      const { service, tenantUpdate } = await buildHarness(
        buildTenant({ enforceMfa: null, sessionTimeoutMinutes: null }),
      );

      await service.updateSecurityPolicy(ADMIN_ID, TENANT_ID, { sessionTimeoutMinutes: 45 });

      expect(tenantUpdate).toHaveBeenCalledTimes(1);
      const [criteria, patch] = tenantUpdate.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(criteria).toEqual({ id: TENANT_ID });
      // The lifecycle columns (status/plan/suspension trio) belong to the
      // command-receipt path; a self-service policy edit must not carry them.
      expect(Object.keys(patch).sort()).toEqual(['enforceMfa', 'sessionTimeoutMinutes']);
      expect(patch['sessionTimeoutMinutes']).toBe(45);
    });

    it('leaves an unspecified field at its stored value (partial update)', async () => {
      const { service, tenantUpdate } = await buildHarness(
        buildTenant({ enforceMfa: true, sessionTimeoutMinutes: 120 }),
      );

      await service.updateSecurityPolicy(ADMIN_ID, TENANT_ID, { sessionTimeoutMinutes: 60 });

      const [, patch] = tenantUpdate.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(patch['enforceMfa']).toBe(true);
      expect(patch['sessionTimeoutMinutes']).toBe(60);
    });
  });

  describe('updateSecurityPolicy — revocation on flip', () => {
    const CANDIDATES = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];

    it('terminates the sessions of every factor-less user when enforcement flips on', async () => {
      const { service, terminatedUserIds, applyImmediately, auditLog } = await buildHarness(
        buildTenant({ enforceMfa: false, sessionTimeoutMinutes: null }),
        CANDIDATES,
      );

      const result = await service.updateSecurityPolicy(ADMIN_ID, TENANT_ID, {
        enforceMfa: true,
      });

      expect(result.enforceMfa).toBe(true);
      expect(terminatedUserIds).toEqual(CANDIDATES);
      // Access tokens die with the refresh tokens: the durable intent advances
      // the user's invalidation epoch and is applied right after commit.
      expect(applyImmediately).toHaveBeenCalledTimes(CANDIDATES.length);

      const auditEntry = auditLog.mock.calls[0]?.[0] as {
        action: string;
        severity: AuditLogSeverity;
        details: Record<string, unknown>;
      };
      expect(auditEntry.action).toBe('TENANT_SECURITY_POLICY_UPDATED');
      expect(auditEntry.severity).toBe(AuditLogSeverity.WARNING);
      expect(auditEntry.details['enforcementFlippedOn']).toBe(true);
      expect(auditEntry.details['revokedUserCount']).toBe(CANDIDATES.length);
    });

    it('terminates nothing when enforcement was ALREADY on (no flip)', async () => {
      const { service, terminatedUserIds, auditLog } = await buildHarness(
        buildTenant({ enforceMfa: true, sessionTimeoutMinutes: null }),
        CANDIDATES,
      );

      await service.updateSecurityPolicy(ADMIN_ID, TENANT_ID, { enforceMfa: true });

      expect(terminatedUserIds).toEqual([]);
      const auditEntry = auditLog.mock.calls[0]?.[0] as {
        severity: AuditLogSeverity;
        details: Record<string, unknown>;
      };
      expect(auditEntry.severity).toBe(AuditLogSeverity.INFO);
      expect(auditEntry.details['enforcementFlippedOn']).toBe(false);
    });

    it('terminates nothing when only the session timeout changes', async () => {
      const { service, terminatedUserIds } = await buildHarness(
        buildTenant({ enforceMfa: false, sessionTimeoutMinutes: 480 }),
        CANDIDATES,
      );

      await service.updateSecurityPolicy(ADMIN_ID, TENANT_ID, { sessionTimeoutMinutes: 15 });

      expect(terminatedUserIds).toEqual([]);
    });
  });

  describe('UpdateTenantSecurityPolicyInput — the 5..1440 bound', () => {
    const validatedProps = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdateTenantSecurityPolicyInput, '', false, false)
        .map((m) => m.propertyName),
    );

    it('validates both policy fields and NOTHING else', () => {
      expect([...validatedProps].sort()).toEqual(['enforceMfa', 'sessionTimeoutMinutes']);
    });

    it('never accepts a tenantId argument on the policy surface', () => {
      // The tenant comes from @Tenant() (JWT / TenantGuard), never from the
      // input — a TENANT_ADMIN cannot address another tenant's policy.
      expect(validatedProps.has('tenantId')).toBe(false);
    });

    it('pins the same 5..1440 bound in the DTO, the entity and the migration', () => {
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..');
      const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf-8');

      const dto = read('apps/auth-service/src/modules/tenant/dto/tenant-policy.dto.ts');
      const entity = read('apps/auth-service/src/modules/tenant/entities/tenant.entity.ts');
      const migration = read(
        'apps/auth-service/src/migrations/1819000000000-AddTenantAuthSecurityPolicy.ts',
      );

      expect(dto).toContain('@Min(5)');
      expect(dto).toContain('@Max(1440)');
      expect(entity).toContain('"session_timeout_minutes" >= 5');
      expect(entity).toContain('"session_timeout_minutes" <= 1440');
      expect(migration).toContain('"session_timeout_minutes" >= 5');
      expect(migration).toContain('"session_timeout_minutes" <= 1440');
    });
  });
});
