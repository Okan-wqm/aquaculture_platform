/**
 * SetupResolver Unit Tests
 *
 * Covers the security-critical paths:
 * - @Roles(Role.MODULE_USER) decorator is present (guards against unauthenticated access)
 * - Resolver returns the expected static status response
 * - Resolver does NOT carry @Public() (which would bypass auth)
 */

import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '@platform/backend-common';
import { SetupResolver } from '../setup.resolver';

describe('SetupResolver', () => {
  let resolver: SetupResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SetupResolver],
    }).compile();

    resolver = module.get<SetupResolver>(SetupResolver);
  });

  describe('hydroponicsStatus query', () => {
    it('returns the expected static status response', async () => {
      const result = await resolver.hydroponicsStatus();

      expect(result).toEqual({
        configured: false,
        moduleName: 'Hydroponics Management',
      });
    });

    it('returns configured: false indicating no active configuration yet', async () => {
      const result = await resolver.hydroponicsStatus();

      expect(result.configured).toBe(false);
    });

    it('returns the correct module name', async () => {
      const result = await resolver.hydroponicsStatus();

      expect(result.moduleName).toBe('Hydroponics Management');
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
