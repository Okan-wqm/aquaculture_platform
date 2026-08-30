import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';

import { CapabilityAuthorityService } from './capability-authority';
import { CATALOGUE_CAPABILITIES } from './permission-catalogue';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = 'actor-uuid-001';

// A fully-licensed tenant (every catalogue capability entitled) — used by the
// authority/subset tests that are not about entitlement itself (RBAC-HIGH-010).
const FULLY_ENTITLED = CATALOGUE_CAPABILITIES;

describe('CapabilityAuthorityService', () => {
  let service: CapabilityAuthorityService;
  let userRepository: jest.Mocked<Pick<Repository<User>, 'findOne'>>;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    userRepository = { findOne: jest.fn() };
    dataSource = { query: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapabilityAuthorityService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<CapabilityAuthorityService>(CapabilityAuthorityService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('resolveActorAuthority', () => {
    it('treats a TENANT_ADMIN inside the tenant as unbounded (isTenantAdmin=true) but still resolves entitlement', async () => {
      userRepository.findOne.mockResolvedValue({ role: Role.TENANT_ADMIN } as User);
      // Entitlement query returns the tenant's enabled module codes.
      dataSource.query.mockResolvedValue([{ code: 'farm' }, { code: 'ai' }]);

      const authority = await service.resolveActorAuthority(TENANT_ID, ACTOR_ID);

      expect(authority.isTenantAdmin).toBe(true);
      // RBAC-HIGH-010: even an admin's authority carries the tenant entitlement,
      // resolved via the module-codes query (tenant-pinned).
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([TENANT_ID]);
      expect(authority.entitled.has('ai_settings:manage')).toBe(true);
    });

    it('resolves a non-admin actor to their OWN effective permissions (role base + overrides)', async () => {
      userRepository.findOne.mockResolvedValue({ role: Role.MODULE_USER } as User);
      // call[0] = effective (role base + overrides); call[1] = entitlement codes.
      dataSource.query
        .mockResolvedValueOnce([
          {
            resource_permissions: ['roles:view', 'roles:create', 'sites:view'],
            permission_overrides: { grants: ['tanks:view'], revokes: ['sites:view'] },
          },
        ])
        .mockResolvedValueOnce([{ code: 'farm' }]);

      const authority = await service.resolveActorAuthority(TENANT_ID, ACTOR_ID);

      expect(authority.isTenantAdmin).toBe(false);
      // revoke removes sites:view, grant adds tanks:view.
      expect([...authority.effective].sort()).toEqual(['roles:create', 'roles:view', 'tanks:view']);
      // Effective query is FIRST and tenant-pinned; entitlement query is second.
      const [, effectiveParams] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(effectiveParams).toEqual([ACTOR_ID, TENANT_ID]);
      const [, entitlementParams] = dataSource.query.mock.calls[1] as [string, unknown[]];
      expect(entitlementParams).toEqual([TENANT_ID]);
    });

    it('FAIL-CLOSED: an unresolved / cross-tenant actor can grant nothing', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const authority = await service.resolveActorAuthority(TENANT_ID, ACTOR_ID);

      expect(authority.isTenantAdmin).toBe(false);
      expect(authority.effective.size).toBe(0);
    });
  });

  describe('assertGrantableResourcePermissions', () => {
    it('rejects a capability outside the catalogue (BadRequest)', () => {
      expect(() =>
        service.assertGrantableResourcePermissions(['billing_admin:manage'], {
          isTenantAdmin: true,
          effective: new Set<string>(),
          entitled: FULLY_ENTITLED,
        }),
      ).toThrow(BadRequestException);
    });

    it('lets an admin grant any catalogue capability', () => {
      const result = service.assertGrantableResourcePermissions(
        ['roles:delete', 'users:edit_permissions'],
        {
          isTenantAdmin: true,
          effective: new Set<string>(),
          entitled: FULLY_ENTITLED,
        },
      );
      expect([...result].sort()).toEqual(['roles:delete', 'users:edit_permissions']);
    });

    it('RBAC-C2: a non-admin CANNOT grant a capability they do not hold (Forbidden)', () => {
      expect(() =>
        service.assertGrantableResourcePermissions(['roles:delete'], {
          isTenantAdmin: false,
          effective: new Set(['roles:view']),
          entitled: FULLY_ENTITLED,
        }),
      ).toThrow(ForbiddenException);
    });

    it('a non-admin MAY grant a subset of their own capabilities', () => {
      const result = service.assertGrantableResourcePermissions(['roles:view'], {
        isTenantAdmin: false,
        effective: new Set(['roles:view', 'roles:create']),
        entitled: FULLY_ENTITLED,
      });
      expect([...result]).toEqual(['roles:view']);
    });
  });

  describe('assertGrantableOverrides', () => {
    it('RBAC-C1: a non-admin cannot GRANT a capability they do not hold', () => {
      expect(() =>
        service.assertGrantableOverrides(
          { grants: ['ai_settings:manage'], revokes: [] },
          {
            isTenantAdmin: false,
            effective: new Set(['ai_assistant:use']),
            entitled: FULLY_ENTITLED,
          },
        ),
      ).toThrow(ForbiddenException);
    });

    it('a non-admin MAY revoke any catalogue capability (revoke needs no authority)', () => {
      const result = service.assertGrantableOverrides(
        { grants: [], revokes: ['roles:delete'] },
        {
          isTenantAdmin: false,
          effective: new Set<string>(),
          entitled: FULLY_ENTITLED,
        },
      );
      expect(result.revokes).toEqual(['roles:delete']);
    });

    it('rejects an unknown capability in grants OR revokes', () => {
      const admin = { isTenantAdmin: true, effective: new Set<string>(), entitled: FULLY_ENTITLED };
      expect(() =>
        service.assertGrantableOverrides({ grants: ['made:up'], revokes: [] }, admin),
      ).toThrow(BadRequestException);
      expect(() =>
        service.assertGrantableOverrides({ grants: [], revokes: ['also:fake'] }, admin),
      ).toThrow(BadRequestException);
    });

    it('deduplicates and accepts a valid admin override set', () => {
      const result = service.assertGrantableOverrides(
        { grants: ['roles:view', 'roles:view'], revokes: ['sites:view'] },
        { isTenantAdmin: true, effective: new Set<string>(), entitled: FULLY_ENTITLED },
      );
      expect(result.grants).toEqual(['roles:view']);
      expect(result.revokes).toEqual(['sites:view']);
    });
  });

  // ==========================================================================
  // RBAC-HIGH-010 — plan/module entitlement (enforced for admins AND delegates)
  // ==========================================================================
  describe('plan-tier / module entitlement', () => {
    // A tenant WITHOUT the AI module: entitled excludes every ai_* capability.
    const withoutAi = new Set([...CATALOGUE_CAPABILITIES].filter((c) => !c.startsWith('ai_')));

    it('an ADMIN cannot grant an AI capability when the tenant lacks the AI module (Forbidden)', () => {
      expect(() =>
        service.assertGrantableResourcePermissions(['ai_settings:manage'], {
          isTenantAdmin: true,
          effective: new Set<string>(),
          entitled: withoutAi,
        }),
      ).toThrow(ForbiddenException);
    });

    it('the entitlement error names the required module', () => {
      expect(() =>
        service.assertGrantableResourcePermissions(['ai_settings:manage'], {
          isTenantAdmin: true,
          effective: new Set<string>(),
          entitled: withoutAi,
        }),
      ).toThrow(/requires the ai module/);
    });

    it('an admin CAN grant the AI capability once the AI module is licensed', () => {
      const result = service.assertGrantableResourcePermissions(['ai_settings:manage'], {
        isTenantAdmin: true,
        effective: new Set<string>(),
        entitled: FULLY_ENTITLED,
      });
      expect([...result]).toEqual(['ai_settings:manage']);
    });

    it('a delegate cannot override-grant a non-entitled capability even if they somehow hold it', () => {
      expect(() =>
        service.assertGrantableOverrides(
          { grants: ['ai_settings:manage'], revokes: [] },
          {
            isTenantAdmin: false,
            effective: new Set(['ai_settings:manage']), // holds it, but tenant lost the module
            entitled: withoutAi,
          },
        ),
      ).toThrow(ForbiddenException);
    });

    it('REVOKING a non-entitled capability is always allowed (cleanup after downgrade)', () => {
      const result = service.assertGrantableOverrides(
        { grants: [], revokes: ['ai_settings:manage'] },
        {
          isTenantAdmin: true,
          effective: new Set<string>(),
          entitled: withoutAi,
        },
      );
      expect(result.revokes).toEqual(['ai_settings:manage']);
    });

    it('core (non-module) capabilities are entitled regardless of modules', () => {
      const coreOnly = new Set<string>(); // tenant with zero modules resolved
      const result = service.assertGrantableResourcePermissions(['roles:view', 'users:invite'], {
        isTenantAdmin: true,
        effective: new Set<string>(),
        entitled: coreOnly.size === 0 ? new Set(['roles:view', 'users:invite']) : coreOnly,
      });
      expect([...result].sort()).toEqual(['roles:view', 'users:invite']);
    });
  });

  describe('serializeOverrides', () => {
    it('serializes only grants/revokes, never the internal brand', () => {
      const validated = service.emptyOverrides();
      const json = CapabilityAuthorityService.serializeOverrides(validated);
      expect(JSON.parse(json)).toEqual({ grants: [], revokes: [] });
      expect(json).not.toContain('capabilityAuthorityValidated');
    });
  });
});
