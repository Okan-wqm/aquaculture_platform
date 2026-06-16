/**
 * SEC-HIGH-052 — MobileFeatureGuard unit tests (London-school).
 *
 * Pins the feature-present-allow + feature-absent-deny + missing-claim-deny +
 * admin-bypass + un-annotated-allow shape that the mobile-reachable mutations
 * rely on for server-side entitlement enforcement.
 */
import { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { MOBILE_FEATURE_KEY } from '../../decorators/requires-mobile-feature.decorator';
import { Role } from '../../decorators/roles.decorator';
import { MobileFeatureGuard } from '../mobile-feature.guard';

interface MockUser {
  sub?: string;
  roles?: (string | Role)[];
  mobileFeatures?: string[];
}

describe('MobileFeatureGuard', () => {
  let reflector: Reflector;
  let guard: MobileFeatureGuard;

  const createContext = (
    requiredFeature: string | undefined,
    user: MockUser | undefined,
  ): ExecutionContext => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredFeature);
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ user }),
        getResponse: jest.fn(),
        getNext: jest.fn(),
      }),
    } as Partial<ExecutionContext> as ExecutionContext;
  };

  beforeEach(() => {
    reflector = new Reflector();
    guard = new MobileFeatureGuard(reflector);
  });

  it('allows an un-annotated route (no metadata, no-op)', () => {
    const ctx = createContext(undefined, { roles: [Role.MODULE_USER] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when the required feature is present in mobileFeatures', () => {
    const ctx = createContext('mortality', {
      roles: [Role.MODULE_USER],
      mobileFeatures: ['mortality', 'cull'],
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies when the required feature is absent from mobileFeatures', () => {
    const ctx = createContext('harvest', {
      roles: [Role.MODULE_USER],
      mobileFeatures: ['mortality'],
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies a non-admin with a MISSING mobileFeatures claim (fail-closed)', () => {
    const ctx = createContext('mortality', { roles: [Role.MODULE_USER] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies a MODULE_MANAGER with a missing claim (manager is NOT admin-bypassed)', () => {
    // MODULE_MANAGER does not satisfy roleHasPermission(role, TENANT_ADMIN),
    // so it must carry the feature claim like any non-admin.
    const ctx = createContext('mortality', { roles: [Role.MODULE_MANAGER] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('bypasses for TENANT_ADMIN with no claim (admin not feature-gated)', () => {
    const ctx = createContext('mortality', { roles: [Role.TENANT_ADMIN] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('bypasses for SUPER_ADMIN with no claim', () => {
    const ctx = createContext('mortality', { roles: [Role.SUPER_ADMIN] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies when there is no user on the request (fail-closed)', () => {
    const ctx = createContext('mortality', undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('reads the metadata via the canonical MOBILE_FEATURE_KEY', () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('feeding');
    const ctx = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ user: { roles: [Role.MODULE_USER], mobileFeatures: ['feeding'] } }),
      }),
    } as Partial<ExecutionContext> as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
    expect(spy).toHaveBeenCalledWith(MOBILE_FEATURE_KEY, expect.any(Array));
  });
});
