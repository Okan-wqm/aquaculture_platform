/**
 * SetupResolver Unit Tests
 *
 * Covers the security-critical paths:
 * - @Roles(Role.MODULE_USER) decorator is present (guards against unauthenticated access)
 * - @Public() is NOT applied (would bypass auth)
 * - hydroponicsStatus tenant-aware behaviour: configured=true iff at
 *   least one HydroponicsConfig row exists for the tenant
 * - hydroponicsStatus returns configured=false when no tenant in context
 *   (federation / unauth fallback) without throwing
 *
 * Why a repository mock now: the resolver was extended (PLAT-HIGH-011
 * series) from a static "moduleName + configured: false" response into
 * a real tenant-scoped query. The spec was carrying the pre-extension
 * shape — cleaned in PR-26 of the PROC-MEDIUM-007 ratchet.
 */

import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ROLES_KEY } from '@aquaculture/backend-common';

import { HydroponicsConfig } from '../../entities/hydroponics-config.entity';
import { SetupResolver } from '../setup.resolver';

describe('SetupResolver', () => {
  let resolver: SetupResolver;
  let configRepository: jest.Mocked<Repository<HydroponicsConfig>>;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const ctxWithTenant = { req: { user: { tenantId } } };
  const ctxWithoutTenant = { req: { user: undefined } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SetupResolver,
        {
          provide: getRepositoryToken(HydroponicsConfig),
          useValue: {
            count: jest.fn(),
          },
        },
      ],
    }).compile();

    resolver = module.get<SetupResolver>(SetupResolver);
    configRepository = module.get(getRepositoryToken(HydroponicsConfig));
  });

  describe('hydroponicsStatus query', () => {
    it('returns configured=false when no config exists for the tenant', async () => {
      configRepository.count.mockResolvedValue(0);

      const result = await resolver.hydroponicsStatus(ctxWithTenant);

      expect(result).toEqual({
        configured: false,
        moduleName: 'Hydroponics Management',
      });
      expect(configRepository.count).toHaveBeenCalledWith({
        where: { tenantId },
      });
    });

    it('returns configured=true when at least one config exists for the tenant', async () => {
      configRepository.count.mockResolvedValue(3);

      const result = await resolver.hydroponicsStatus(ctxWithTenant);

      expect(result.configured).toBe(true);
      expect(result.moduleName).toBe('Hydroponics Management');
    });

    it('returns configured=false when context has no tenantId (does NOT query the repo)', async () => {
      const result = await resolver.hydroponicsStatus(ctxWithoutTenant);

      expect(result.configured).toBe(false);
      expect(result.moduleName).toBe('Hydroponics Management');
      // Critical: no DB call when tenant is missing — the resolver
      // MUST NOT issue a tenant-less query that could leak cross-tenant
      // counts. (Mirrors the federation-resolver discipline used in
      // sensor-service / farm-service.)
      expect(configRepository.count).not.toHaveBeenCalled();
    });
  });

  describe('authorization metadata', () => {
    it('has @Roles() decorator applied to hydroponicsStatus — prevents unauthenticated access', () => {
      // The Reflector reads the metadata set by @Roles() on the handler method
      const reflector = new Reflector();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = resolver.hydroponicsStatus;
      const roles = reflector.get<string[]>(ROLES_KEY, handler);

      expect(roles).toBeDefined();
      expect(Array.isArray(roles)).toBe(true);
      expect(roles!.length).toBeGreaterThan(0);
    });

    it('does NOT carry the @Public() decorator — all callers must be authenticated', () => {
      // @Public() sets IS_PUBLIC_KEY metadata. If present, RolesGuard skips auth.
      const IS_PUBLIC_KEY = 'isPublic';
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const roles = Reflect.getMetadata(IS_PUBLIC_KEY, resolver.hydroponicsStatus);
      expect(roles).toBeUndefined();
    });

    it('does NOT carry the @Public() decorator on the resolver class itself', () => {
      const IS_PUBLIC_KEY = 'isPublic';
      const roles = Reflect.getMetadata(IS_PUBLIC_KEY, SetupResolver);
      expect(roles).toBeUndefined();
    });
  });
});
