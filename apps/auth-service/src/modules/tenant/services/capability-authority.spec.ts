import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';

import { CapabilityAuthorityService } from './capability-authority';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = 'actor-uuid-001';

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
    it('treats a TENANT_ADMIN inside the tenant as unbounded (isTenantAdmin=true)', async () => {
      userRepository.findOne.mockResolvedValue({ role: Role.TENANT_ADMIN } as User);

      const authority = await service.resolveActorAuthority(TENANT_ID, ACTOR_ID);

      expect(authority.isTenantAdmin).toBe(true);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('resolves a non-admin actor to their OWN effective permissions (role base + overrides)', async () => {
      userRepository.findOne.mockResolvedValue({ role: Role.MODULE_USER } as User);
      dataSource.query.mockResolvedValue([
        {
          resource_permissions: ['roles:view', 'roles:create', 'sites:view'],
          permission_overrides: { grants: ['tanks:view'], revokes: ['sites:view'] },
        },
      ]);

      const authority = await service.resolveActorAuthority(TENANT_ID, ACTOR_ID);

      expect(authority.isTenantAdmin).toBe(false);
      // revoke removes sites:view, grant adds tanks:view.
      expect([...authority.effective].sort()).toEqual(['roles:create', 'roles:view', 'tanks:view']);
      // Effective query is tenant-pinned.
      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([ACTOR_ID, TENANT_ID]);
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
        }),
      ).toThrow(BadRequestException);
    });

    it('lets an admin grant any catalogue capability', () => {
      const result = service.assertGrantableResourcePermissions(['roles:delete', 'users:edit_permissions'], {
        isTenantAdmin: true,
        effective: new Set<string>(),
      });
      expect([...result].sort()).toEqual(['roles:delete', 'users:edit_permissions']);
    });

    it('RBAC-C2: a non-admin CANNOT grant a capability they do not hold (Forbidden)', () => {
      expect(() =>
        service.assertGrantableResourcePermissions(['roles:delete'], {
          isTenantAdmin: false,
          effective: new Set(['roles:view']),
        }),
      ).toThrow(ForbiddenException);
    });

    it('a non-admin MAY grant a subset of their own capabilities', () => {
      const result = service.assertGrantableResourcePermissions(['roles:view'], {
        isTenantAdmin: false,
        effective: new Set(['roles:view', 'roles:create']),
      });
      expect([...result]).toEqual(['roles:view']);
    });
  });

  describe('assertGrantableOverrides', () => {
    it('RBAC-C1: a non-admin cannot GRANT a capability they do not hold', () => {
      expect(() =>
        service.assertGrantableOverrides({ grants: ['ai_settings:manage'], revokes: [] }, {
          isTenantAdmin: false,
          effective: new Set(['ai_assistant:use']),
        }),
      ).toThrow(ForbiddenException);
    });

    it('a non-admin MAY revoke any catalogue capability (revoke needs no authority)', () => {
      const result = service.assertGrantableOverrides({ grants: [], revokes: ['roles:delete'] }, {
        isTenantAdmin: false,
        effective: new Set<string>(),
      });
      expect(result.revokes).toEqual(['roles:delete']);
    });

    it('rejects an unknown capability in grants OR revokes', () => {
      const admin = { isTenantAdmin: true, effective: new Set<string>() };
      expect(() => service.assertGrantableOverrides({ grants: ['made:up'], revokes: [] }, admin)).toThrow(
        BadRequestException,
      );
      expect(() => service.assertGrantableOverrides({ grants: [], revokes: ['also:fake'] }, admin)).toThrow(
        BadRequestException,
      );
    });

    it('deduplicates and accepts a valid admin override set', () => {
      const result = service.assertGrantableOverrides(
        { grants: ['roles:view', 'roles:view'], revokes: ['sites:view'] },
        { isTenantAdmin: true, effective: new Set<string>() },
      );
      expect(result.grants).toEqual(['roles:view']);
      expect(result.revokes).toEqual(['sites:view']);
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
