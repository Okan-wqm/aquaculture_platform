import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { TenantGuard } from '../tenant.guard';
import { AuditLogService } from '../../audit/audit-log.service';
import { AuditSeverity } from '../../audit/audit-log.entity';
import { IS_PUBLIC_KEY, SKIP_TENANT_GUARD_KEY, Role } from '../../decorators/roles.decorator';
import { JwtUser } from '../../types/tenant-request.interface';

/**
 * Unit tests for TenantGuard — H-13 security finding fix.
 *
 * Verifies:
 * - Persistent audit logging for SUPER_ADMIN cross-tenant access
 * - MFA step-up enforcement when MFA_REQUIRED_FOR_CROSS_TENANT=true
 * - Graceful degradation when AuditLogService is not available
 * - Existing tenant isolation behaviour is preserved
 */
describe('TenantGuard', () => {
  let reflector: Reflector;
  let auditLogService: jest.Mocked<Pick<AuditLogService, 'record'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;

  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';

  /**
   * Creates a mock ExecutionContext for HTTP requests.
   */
  const createMockContext = (
    user?: JwtUser,
    headers: Record<string, string | undefined> = {},
  ): ExecutionContext => {
    const mockRequest = {
      user,
      headers,
      method: 'GET',
      url: '/api/test',
      ip: '127.0.0.1',
      tenantId: undefined as string | undefined,
    };

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

  /**
   * Build a SUPER_ADMIN user payload for testing.
   */
  const superAdminUser = (overrides: Partial<JwtUser> = {}): JwtUser => ({
    sub: 'admin-001',
    tenantId: TENANT_A,
    roles: [Role.SUPER_ADMIN],
    ...overrides,
  });

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    auditLogService = {
      record: jest.fn(),
    };

    configService = {
      get: jest.fn().mockReturnValue('false'),
    };
  });

  /**
   * Helper to create a guard with specific config.
   */
  const createGuard = (
    opts: {
      withAudit?: boolean;
      mfaRequired?: boolean;
    } = {},
  ): TenantGuard => {
    const { withAudit = true, mfaRequired = false } = opts;

    if (mfaRequired) {
      configService.get.mockReturnValue('true');
    }

    return new TenantGuard(
      reflector,
      withAudit ? (auditLogService as unknown as AuditLogService) : undefined,
      configService as unknown as ConfigService,
    );
  };

  // -------------------------------------------------------------------
  // Baseline: existing behaviour preserved
  // -------------------------------------------------------------------

  describe('existing behaviour (baseline)', () => {
    it('should allow public endpoints', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        return undefined;
      });
      const guard = createGuard();
      const context = createMockContext();
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow endpoints with @SkipTenantGuard()', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_TENANT_GUARD_KEY) return true;
        return undefined;
      });
      const guard = createGuard();
      const context = createMockContext();
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should throw BadRequestException when regular user has no tenantId', () => {
      const guard = createGuard();
      const context = createMockContext({ sub: 'user-1', roles: [Role.MODULE_USER] });
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid UUID tenantId', () => {
      const guard = createGuard();
      const context = createMockContext({ sub: 'user-1', tenantId: 'not-a-uuid', roles: [Role.MODULE_USER] });
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it('should set request.tenantId from JWT for regular users', () => {
      const guard = createGuard();
      const context = createMockContext({
        sub: 'user-1',
        tenantId: TENANT_A,
        roles: [Role.MODULE_USER],
      });

      expect(guard.canActivate(context)).toBe(true);

      const request = context.switchToHttp().getRequest();
      expect(request.tenantId).toBe(TENANT_A);
    });

    it('should allow SUPER_ADMIN without X-Act-As-Tenant header', () => {
      const guard = createGuard();
      const context = createMockContext(superAdminUser());
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should throw BadRequestException for invalid X-Act-As-Tenant UUID', () => {
      const guard = createGuard();
      const context = createMockContext(
        superAdminUser(),
        { 'x-act-as-tenant': 'bad-uuid' },
      );
      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------
  // H-13 Part 1: Persistent audit logging for cross-tenant access
  // -------------------------------------------------------------------

  describe('H-13: persistent audit logging', () => {
    it('should call AuditLogService.record() for cross-tenant access', () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledTimes(1);
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUPER_ADMIN_CROSS_TENANT_ACCESS',
          resource: 'TenantGuard',
          resourceId: TENANT_B,
          userId: 'admin-001',
          tenantId: TENANT_B,
          severity: AuditSeverity.WARNING,
          metadata: expect.objectContaining({
            sourceTenantId: TENANT_A,
            targetTenantId: TENANT_B,
            endpoint: 'GET /api/test',
            mfaVerified: false,
          }),
        }),
      );
    });

    it('should NOT call AuditLogService.record() when accessing own tenant', () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: TENANT_A });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_A });

      guard.canActivate(context);

      expect(auditLogService.record).not.toHaveBeenCalled();
    });

    it('should include client IP from X-Forwarded-For in audit record', () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, {
        'x-act-as-tenant': TENANT_B,
        'x-forwarded-for': '203.0.113.50, 10.0.0.1',
      });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '203.0.113.50',
        }),
      );
    });

    it('should include user agent in audit record', () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, {
        'x-act-as-tenant': TENANT_B,
        'user-agent': 'Mozilla/5.0 TestBrowser',
      });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'Mozilla/5.0 TestBrowser',
        }),
      );
    });

    it('should include mfaVerified=true in metadata when MFA is verified', () => {
      const guard = createGuard();
      const user = superAdminUser({ mfaVerified: true });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            mfaVerified: true,
          }),
        }),
      );
    });

    it('should use sourceTenantId "system" when SUPER_ADMIN has no tenantId', () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: undefined });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            sourceTenantId: 'system',
          }),
        }),
      );
    });

    it('should gracefully degrade when AuditLogService is not available', () => {
      const guard = createGuard({ withAudit: false });
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      // Should not throw — just logs ephemerally
      expect(() => guard.canActivate(context)).not.toThrow();
      expect(auditLogService.record).not.toHaveBeenCalled();
    });

    it('should set request.tenantId to target tenant after audit', () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      guard.canActivate(context);

      const request = context.switchToHttp().getRequest();
      expect(request.tenantId).toBe(TENANT_B);
    });
  });

  // -------------------------------------------------------------------
  // H-13 Part 2: MFA step-up enforcement
  // -------------------------------------------------------------------

  describe('H-13: MFA step-up enforcement', () => {
    it('should NOT require MFA when MFA_REQUIRED_FOR_CROSS_TENANT is false', () => {
      const guard = createGuard({ mfaRequired: false });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(() => guard.canActivate(context)).not.toThrow();
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should throw ForbiddenException when MFA is required but not verified', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        /MFA verification is required/,
      );
    });

    it('should throw ForbiddenException when MFA is required and mfaVerified is undefined', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser(); // no mfaVerified field
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow cross-tenant access when MFA is required and verified', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: true });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(guard.canActivate(context)).toBe(true);
      expect(auditLogService.record).toHaveBeenCalledTimes(1);
    });

    it('should NOT require MFA for same-tenant access even if env var is set', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: TENANT_A, mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_A });

      // Same tenant => no MFA check
      expect(() => guard.canActivate(context)).not.toThrow();
    });

    it('should NOT audit-log when MFA check fails (request is rejected)', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);

      // Audit record should NOT be created for rejected requests
      expect(auditLogService.record).not.toHaveBeenCalled();
    });

    it('should NOT require MFA for SUPER_ADMIN without X-Act-As-Tenant header', () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user);

      // No X-Act-As-Tenant header => no cross-tenant => no MFA check
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  describe('edge cases', () => {
    it('should support deprecated "role" field for SUPER_ADMIN detection', () => {
      const guard = createGuard();
      const user: JwtUser = {
        sub: 'admin-002',
        tenantId: TENANT_A,
        role: Role.SUPER_ADMIN,
      };
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      expect(guard.canActivate(context)).toBe(true);
      expect(auditLogService.record).toHaveBeenCalledTimes(1);
    });

    it('should include email in audit record when available', () => {
      const guard = createGuard();
      const user = superAdminUser({ email: 'admin@example.com' });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      guard.canActivate(context);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userEmail: 'admin@example.com',
        }),
      );
    });
  });
});
