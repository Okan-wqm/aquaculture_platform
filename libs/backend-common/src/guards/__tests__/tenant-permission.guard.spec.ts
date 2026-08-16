import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRED_TENANT_PERMISSIONS_KEY } from '../../decorators/require-permission.decorator';
import { IS_PUBLIC_KEY, Role } from '../../decorators/roles.decorator';
import { TenantPermissionGuard } from '../tenant-permission.guard';

describe('TenantPermissionGuard', () => {
  let guard: TenantPermissionGuard;
  let reflector: Reflector;

  const createMockContext = (user?: Record<string, unknown>): ExecutionContext => {
    const mockRequest = { user };
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: jest.fn(),
        getNext: jest.fn(),
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    reflector = new Reflector();
    guard = new TenantPermissionGuard(reflector);
  });

  describe('when no decorator is present (opt-in)', () => {
    it('should allow access when no required permissions are set', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext({
        sub: 'user1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when required permissions array is empty', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return [];
        return undefined;
      });
      const context = createMockContext({
        sub: 'user1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
      });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('when endpoint is public', () => {
    it('should allow access regardless of permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:create'];
        return undefined;
      });
      const context = createMockContext(); // no user
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('SUPER_ADMIN bypass', () => {
    it('should allow access for SUPER_ADMIN regardless of permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:create', 'sensors:calibrate'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'admin1',
        role: Role.SUPER_ADMIN,
        roles: [Role.SUPER_ADMIN],
      });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('TENANT_ADMIN bypass', () => {
    it('should allow access for TENANT_ADMIN regardless of permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:delete', 'users:deactivate'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'tadmin1',
        role: Role.TENANT_ADMIN,
        roles: [Role.TENANT_ADMIN],
        tenantId: 'tenant-1',
      });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('MODULE_MANAGER permission check', () => {
    it('should allow access when user has all required permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:view', 'tanks:create'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mm1',
        role: Role.MODULE_MANAGER,
        roles: [Role.MODULE_MANAGER],
        tenantId: 'tenant-1',
        resourcePermissions: ['tanks:view', 'tanks:create', 'tanks:edit'],
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user is missing a required permission', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:view', 'tanks:delete'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mm1',
        role: Role.MODULE_MANAGER,
        roles: [Role.MODULE_MANAGER],
        tenantId: 'tenant-1',
        resourcePermissions: ['tanks:view', 'tanks:create'],
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('MODULE_USER permission check', () => {
    it('should allow access when user has the single required permission', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['sensors:view'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mu1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: 'tenant-1',
        resourcePermissions: ['sensors:view', 'water_quality:view'],
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user has no resourcePermissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:create'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mu1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: 'tenant-1',
        // no resourcePermissions field
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when user has empty resourcePermissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:create'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mu1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: 'tenant-1',
        resourcePermissions: [],
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('no user on request', () => {
    it('should deny access when no user is present', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:view'];
        return undefined;
      });
      const context = createMockContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('case-insensitive role matching', () => {
    it('should handle lowercase role values from JWT', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY) return ['tanks:create'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'admin1',
        role: 'super_admin', // lowercase
        roles: ['super_admin'],
      });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('multiple required permissions (AND logic)', () => {
    it('should require ALL permissions (not any)', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === REQUIRED_TENANT_PERMISSIONS_KEY)
          return ['tanks:view', 'tanks:create', 'tanks:delete'];
        return undefined;
      });
      const context = createMockContext({
        sub: 'mu1',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: 'tenant-1',
        resourcePermissions: ['tanks:view', 'tanks:create'], // missing tanks:delete
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});
