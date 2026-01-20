/**
 * PermissionGuard Tests
 *
 * Comprehensive test suite for permission-based access control
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { JwtPayload } from '../auth.guard';
import {
  PermissionGuard,
  PERMISSIONS_KEY,
  PERMISSION_MODE_KEY,
  ROLES_KEY,
  RESOURCE_PERMISSION_KEY,
  PermissionMode,
  ResourcePermission,
  userHasPermission,
  userHasRole,
} from '../permission.guard';

describe('PermissionGuard', () => {
  let guard: PermissionGuard;
  let reflector: Reflector;

  /**
   * Create mock execution context
   */
  const createMockExecutionContext = (
    user: Partial<JwtPayload> | null = null,
    params: Record<string, string> = {},
  ): ExecutionContext => {
    const mockRequest = {
      user: user
        ? {
            sub: 'user-123',
            tenantId: 'tenant-123',
            roles: ['user'],
            type: 'access' as const,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...user,
          }
        : null,
      params,
      headers: {},
      path: '/api/v1/test',
      method: 'GET',
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => ({
        name: 'testHandler',
      }),
      getClass: () => ({
        name: 'TestController',
      }),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                PERMISSION_CACHE_TTL: 300000,
                PERMISSION_AUDIT_LOG: true,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<PermissionGuard>(PermissionGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('Authentication Check', () => {
    it('should reject unauthenticated users', () => {
      const context = createMockExecutionContext(null);

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['read'];
        return undefined;
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow access when no permissions required', () => {
      const context = createMockExecutionContext({ sub: 'user-1' });

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Permission Checks (AND Mode)', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read', 'sensors:read'];
        if (key === PERMISSION_MODE_KEY) return PermissionMode.ALL;
        return undefined;
      });
    });

    it('should allow user with all required permissions', () => {
      const context = createMockExecutionContext({
        roles: ['manager'],
        permissions: ['farms:read', 'sensors:read'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject user missing one permission', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['farms:read'], // Missing sensors:read
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should reject user with no matching permissions', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['unrelated:permission'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Permission Checks (OR Mode)', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read', 'sensors:read'];
        if (key === PERMISSION_MODE_KEY) return PermissionMode.ANY;
        return undefined;
      });
    });

    it('should allow user with any of the required permissions', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['farms:read'], // Only has one
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow user with all of the required permissions', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['farms:read', 'sensors:read'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject user with none of the required permissions', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['unrelated:permission'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Wildcard Permissions', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read', 'farms:update', 'sensors:read'];
        return undefined;
      });
    });

    it('should allow system admin with wildcard permission', () => {
      const context = createMockExecutionContext({
        roles: ['system_admin'],
        permissions: ['*'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow user with resource wildcard (farms:*)', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['farms:*', 'sensors:read'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow user with manage permission covering all actions', () => {
      const context = createMockExecutionContext({
        roles: ['user'],
        permissions: ['farms:manage', 'sensors:manage'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Role-Based Access', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['manager'];
        return undefined;
      });
    });

    it('should allow user with exact required role', () => {
      const context = createMockExecutionContext({
        roles: ['manager'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow user with higher role in hierarchy', () => {
      const context = createMockExecutionContext({
        roles: ['tenant_admin'], // Higher than manager
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow system admin for any role requirement', () => {
      const context = createMockExecutionContext({
        roles: ['system_admin'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject user with lower role', () => {
      const context = createMockExecutionContext({
        roles: ['operator'], // Lower than manager
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should reject user with no matching roles', () => {
      const context = createMockExecutionContext({
        roles: ['viewer'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Role Hierarchy', () => {
    it('should inherit permissions from system_admin', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['any:permission'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['system_admin'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow tenant_admin to access manager resources', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['manager'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['tenant_admin'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow manager to access operator resources', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['operator'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['manager'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should not allow operator to access manager resources', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['manager'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['operator'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Resource-Based Permissions', () => {
    it('should check resource:action permission', () => {
      const resourcePermission: ResourcePermission = {
        resource: 'farms',
        action: 'update',
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === RESOURCE_PERMISSION_KEY) return resourcePermission;
        return undefined;
      });

      const context = createMockExecutionContext({
        permissions: ['farms:update'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow manage permission for any action', () => {
      const resourcePermission: ResourcePermission = {
        resource: 'farms',
        action: 'delete',
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === RESOURCE_PERMISSION_KEY) return resourcePermission;
        return undefined;
      });

      const context = createMockExecutionContext({
        permissions: ['farms:manage'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject user without resource permission', () => {
      const resourcePermission: ResourcePermission = {
        resource: 'farms',
        action: 'delete',
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === RESOURCE_PERMISSION_KEY) return resourcePermission;
        return undefined;
      });

      const context = createMockExecutionContext({
        permissions: ['farms:read'], // Only has read
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should evaluate custom condition function', () => {
      const resourcePermission: ResourcePermission = {
        resource: 'farms',
        action: 'update',
        condition: (_user, resourceId) => {
          return resourceId === 'user-owned-farm';
        },
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === RESOURCE_PERMISSION_KEY) return resourcePermission;
        return undefined;
      });

      const context = createMockExecutionContext(
        { permissions: ['farms:update'] },
        { id: 'user-owned-farm' },
      );

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject when custom condition returns false', () => {
      const resourcePermission: ResourcePermission = {
        resource: 'farms',
        action: 'update',
        condition: (_user, resourceId) => {
          return resourceId === 'user-owned-farm';
        },
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === RESOURCE_PERMISSION_KEY) return resourcePermission;
        return undefined;
      });

      const context = createMockExecutionContext(
        { permissions: ['farms:update'] },
        { id: 'other-farm' },
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Combined Checks', () => {
    it('should check both roles and permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['manager'];
        if (key === PERMISSIONS_KEY) return ['reports:view'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['manager'],
        permissions: ['reports:view'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject if role check fails even with permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return ['tenant_admin'];
        if (key === PERMISSIONS_KEY) return ['reports:view'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['operator'], // Lower than required
        permissions: ['reports:view'],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Role-Based Default Permissions', () => {
    it('should grant tenant_admin role-based permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['users:manage'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['tenant_admin'],
        permissions: [], // No explicit permissions, relies on role
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should grant manager role-based permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['manager'],
        permissions: [],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should grant operator role-based permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['alerts:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['operator'],
        permissions: [],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should grant viewer role-based permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['viewer'],
        permissions: [],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Cache Management', () => {
    it('should cache permission calculations', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        sub: 'cached-user',
        tenantId: 'tenant-1',
        roles: ['viewer'],
      });

      // First call
      guard.canActivate(context);

      // Second call should use cache
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should clear cache for specific user', () => {
      guard.clearCache('user-123', 'tenant-123');
      // No error should be thrown
    });

    it('should clear all cache', () => {
      guard.clearAllCache();
      // No error should be thrown
    });
  });

  describe('Audit Logging', () => {
    it('should log permission granted events', () => {
      const debugSpy = jest.spyOn(guard['logger'], 'debug');

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['viewer'],
        permissions: ['farms:read'],
      });

      guard.canActivate(context);

      expect(debugSpy).toHaveBeenCalled();
    });

    it('should log permission denied events', () => {
      const warnSpy = jest.spyOn(guard['logger'], 'warn');

      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['admin:permission'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['viewer'],
        permissions: [],
      });

      try {
        guard.canActivate(context);
      } catch {
        // Expected
      }

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Helper Functions', () => {
    describe('userHasPermission', () => {
      it('should return true for exact permission match', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['user'],
          permissions: ['farms:read'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasPermission(user, 'farms:read')).toBe(true);
      });

      it('should return true for wildcard permission', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['system_admin'],
          permissions: ['*'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasPermission(user, 'any:permission')).toBe(true);
      });

      it('should return true for resource wildcard', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['user'],
          permissions: ['farms:*'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasPermission(user, 'farms:delete')).toBe(true);
      });

      it('should return false for missing permission', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['user'],
          permissions: ['farms:read'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasPermission(user, 'sensors:read')).toBe(false);
      });
    });

    describe('userHasRole', () => {
      it('should return true for exact role match', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['manager'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasRole(user, 'manager')).toBe(true);
      });

      it('should return true for inherited role', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['system_admin'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasRole(user, 'operator')).toBe(true);
      });

      it('should return false for higher role', () => {
        const user: JwtPayload = {
          sub: 'user-1',
          tenantId: 'tenant-1',
          roles: ['operator'],
          type: 'access',
          iat: 0,
          exp: 0,
        };

        expect(userHasRole(user, 'manager')).toBe(false);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle user with empty permissions array', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['viewer'], // Has role-based permissions
        permissions: [],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true); // Should still work via role
    });

    it('should handle user with undefined permissions', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['viewer'],
        permissions: undefined,
      } as Partial<JwtPayload>);

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle multiple roles', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['users:manage', 'reports:view'];
        return undefined;
      });

      const context = createMockExecutionContext({
        roles: ['manager', 'tenant_admin'],
        permissions: [],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle permission with special characters', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['resource-name:action_name'];
        return undefined;
      });

      const context = createMockExecutionContext({
        permissions: ['resource-name:action_name'],
      });

      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should handle rapid permission checks efficiently', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSIONS_KEY) return ['farms:read'];
        return undefined;
      });

      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const context = createMockExecutionContext({
          sub: `user-${i}`,
          roles: ['viewer'],
          permissions: ['farms:read'],
        });

        guard.canActivate(context);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
