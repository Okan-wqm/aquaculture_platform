import { mockCallArgument } from '@aquaculture/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AuditSeverity } from '../../audit/audit-log.entity';
import { AuditLogService, type CreateAuditEntryDto } from '../../audit/audit-log.service';
import { IS_PUBLIC_KEY, SKIP_TENANT_GUARD_KEY, Role } from '../../decorators/roles.decorator';
import {
  JwtUser,
  TenantRequest,
  VerifiedServiceIdentity,
  VerifiedUserAssertion,
} from '../../types/tenant-request.interface';
import { TenantGuard } from '../tenant.guard';

/**
 * Unit tests for TenantGuard — H-13 + BULGU-4 + ONEMLI-05 security fixes.
 *
 * Verifies:
 * - Persistent audit logging for SUPER_ADMIN cross-tenant access
 * - MFA step-up enforcement when MFA_REQUIRED_FOR_CROSS_TENANT=true
 * - Graceful degradation when AuditLogService is not available
 * - Existing tenant isolation behaviour is preserved
 * - canActivate returns Promise<boolean> (ONEMLI-05)
 * - Cross-tenant audit uses recordAwait instead of fire-and-forget (BULGU-4)
 * - Audit write failure does not block the request (BULGU-4)
 */
describe('TenantGuard', () => {
  let reflector: Reflector;
  let auditLogService: jest.Mocked<
    Pick<AuditLogService, 'record' | 'recordAwait' | 'getFailureCount'>
  >;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;

  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';

  function recordedAuditEntry(): CreateAuditEntryDto {
    return mockCallArgument<CreateAuditEntryDto>(auditLogService.recordAwait);
  }

  /**
   * Creates a mock ExecutionContext for HTTP requests.
   */
  const createMockContext = (
    user?: JwtUser,
    headers: Record<string, string | undefined> = {},
    verifiedUserAssertion?: VerifiedUserAssertion,
    verifiedIdentity?: VerifiedServiceIdentity,
  ): ExecutionContext => {
    const mockRequest = {
      user,
      headers,
      verifiedUserAssertion,
      verifiedIdentity,
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
      recordAwait: jest.fn().mockResolvedValue(undefined),
      getFailureCount: jest.fn().mockReturnValue(0),
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
      withAudit ? auditLogService : undefined,
      configService as unknown as ConfigService,
    );
  };

  // -------------------------------------------------------------------
  // Baseline: existing behaviour preserved
  // -------------------------------------------------------------------

  describe('existing behaviour (baseline)', () => {
    it('should return a Promise (ONEMLI-05)', async () => {
      const guard = createGuard();
      const context = createMockContext({
        sub: 'user-1',
        tenantId: TENANT_A,
        roles: [Role.MODULE_USER],
      });
      const result = guard.canActivate(context);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe(true);
    });

    it('should allow public endpoints', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        return undefined;
      });
      const guard = createGuard();
      const context = createMockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should allow endpoints with @SkipTenantGuard()', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_TENANT_GUARD_KEY) return true;
        return undefined;
      });
      const guard = createGuard();
      const context = createMockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should throw BadRequestException when regular user has no tenantId', async () => {
      const guard = createGuard();
      const context = createMockContext({ sub: 'user-1', roles: [Role.MODULE_USER] });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid UUID tenantId', async () => {
      const guard = createGuard();
      const context = createMockContext({
        sub: 'user-1',
        tenantId: 'not-a-uuid',
        roles: [Role.MODULE_USER],
      });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('should set request.tenantId from JWT for regular users', async () => {
      const guard = createGuard();
      const context = createMockContext({
        sub: 'user-1',
        tenantId: TENANT_A,
        roles: [Role.MODULE_USER],
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);

      const request = context.switchToHttp().getRequest<TenantRequest>();
      expect(request.tenantId).toBe(TENANT_A);
    });

    it('should allow SUPER_ADMIN without X-Act-As-Tenant header', async () => {
      const guard = createGuard();
      const context = createMockContext(superAdminUser());
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should throw BadRequestException for invalid X-Act-As-Tenant UUID', async () => {
      const guard = createGuard();
      const context = createMockContext(superAdminUser(), { 'x-act-as-tenant': 'bad-uuid' });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------
  // H-13 Part 1: Persistent audit logging for cross-tenant access
  // -------------------------------------------------------------------

  describe('H-13: persistent audit logging', () => {
    it('should call AuditLogService.recordAwait() for cross-tenant access (BULGU-4)', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).toHaveBeenCalledTimes(1);
      const entry = recordedAuditEntry();
      expect(entry).toMatchObject({
        action: 'SUPER_ADMIN_CROSS_TENANT_ACCESS',
        resource: 'TenantGuard',
        resourceId: TENANT_B,
        userId: 'admin-001',
        tenantId: TENANT_B,
        severity: AuditSeverity.WARNING,
      });
      expect(entry.metadata).toMatchObject({
        sourceTenantId: TENANT_A,
        targetTenantId: TENANT_B,
        endpoint: 'GET /api/test',
        mfaVerified: false,
      });
    });

    it('should NOT call AuditLogService.recordAwait() when accessing own tenant', async () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: TENANT_A });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_A });

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should prefer request.ip over X-Forwarded-For in audit record (BULGU-7)', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, {
        'x-act-as-tenant': TENANT_B,
        'x-forwarded-for': '203.0.113.50, 10.0.0.1',
      });

      await guard.canActivate(context);

      // BULGU-7: request.ip is preferred because it respects trust proxy config
      expect(recordedAuditEntry().ip).toBe('127.0.0.1');
    });

    it('should fall back to X-Forwarded-For when request.ip is unavailable', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      // Create context with no ip property to test X-Forwarded-For fallback
      const mockRequest = {
        user,
        headers: {
          'x-act-as-tenant': TENANT_B,
          'x-forwarded-for': '203.0.113.50, 10.0.0.1',
        } as Record<string, string | undefined>,
        method: 'GET',
        url: '/api/test',
        ip: undefined as string | undefined,
        tenantId: undefined as string | undefined,
      };
      const context = {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: jest.fn(),
          getNext: jest.fn(),
        }),
      } as unknown as ExecutionContext;
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      await guard.canActivate(context);

      expect(recordedAuditEntry().ip).toBe('203.0.113.50');
    });

    it('should include user agent in audit record', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, {
        'x-act-as-tenant': TENANT_B,
        'user-agent': 'Mozilla/5.0 TestBrowser',
      });

      await guard.canActivate(context);

      expect(recordedAuditEntry().userAgent).toBe('Mozilla/5.0 TestBrowser');
    });

    it('should include mfaVerified=true in metadata when MFA is verified', async () => {
      const guard = createGuard();
      const user = superAdminUser({ mfaVerified: true });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      expect(recordedAuditEntry().metadata).toMatchObject({ mfaVerified: true });
    });

    it('should use sourceTenantId "system" when SUPER_ADMIN has no tenantId', async () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: undefined });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      expect(recordedAuditEntry().metadata).toMatchObject({ sourceTenantId: 'system' });
    });

    it('should gracefully degrade when AuditLogService is not available', async () => {
      const guard = createGuard({ withAudit: false });
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      // Should not throw — just logs ephemerally
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should set request.tenantId to target tenant after audit', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      const request = context.switchToHttp().getRequest<TenantRequest>();
      expect(request.tenantId).toBe(TENANT_B);
    });
  });

  // -------------------------------------------------------------------
  // BULGU-4: Audit write failure resilience
  // -------------------------------------------------------------------

  describe('BULGU-4: audit write failure resilience', () => {
    it('should not block the request when audit write fails', async () => {
      auditLogService.recordAwait.mockRejectedValueOnce(new Error('DB connection lost'));
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      // The guard should still return true despite the audit write failure
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should still set request.tenantId when audit write fails', async () => {
      auditLogService.recordAwait.mockRejectedValueOnce(new Error('DB connection lost'));
      const guard = createGuard();
      const user = superAdminUser();
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      const request = context.switchToHttp().getRequest<TenantRequest>();
      expect(request.tenantId).toBe(TENANT_B);
    });
  });

  // -------------------------------------------------------------------
  // H-13 Part 2: MFA step-up enforcement
  // -------------------------------------------------------------------

  describe('H-13: MFA step-up enforcement', () => {
    it('should NOT require MFA when MFA_REQUIRED_FOR_CROSS_TENANT is false', async () => {
      const guard = createGuard({ mfaRequired: false });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should throw ForbiddenException when MFA is required but not verified', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException with descriptive message when MFA is missing', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).rejects.toThrow(/MFA verification is required/);
    });

    it('should throw ForbiddenException when MFA is required and mfaVerified is undefined', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser(); // no mfaVerified field
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should allow cross-tenant access when MFA is required and verified', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: true });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(auditLogService.recordAwait).toHaveBeenCalledTimes(1);
    });

    it('should NOT require MFA for same-tenant access even if env var is set', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: TENANT_A, mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_A });

      // Same tenant => no MFA check
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should NOT audit-log when MFA check fails (request is rejected)', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);

      // Audit record should NOT be created for rejected requests
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should NOT require MFA for SUPER_ADMIN without X-Act-As-Tenant header', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createMockContext(user);

      // No X-Act-As-Tenant header => no cross-tenant => no MFA check
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('requires MFA by default when the configuration value is absent', async () => {
      configService.get.mockReturnValue(undefined);
      const guard = createGuard();
      const context = createMockContext(
        superAdminUser({ tenantId: undefined, mfaVerified: false }),
        {},
        {
          issuer: 'gateway-api',
          subject: 'admin-001',
          tenantId: null,
          effectiveTenantId: TENANT_B,
          roles: [Role.SUPER_ADMIN],
          email: null,
          mfaVerified: false,
          issuedAt: new Date().toISOString(),
        },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('signed effective-tenant assertion', () => {
    it('uses the verified gateway effective tenant on auth direct-JWT paths', async () => {
      const guard = createGuard({ mfaRequired: true });
      const context = createMockContext(
        superAdminUser({ tenantId: undefined, mfaVerified: true }),
        { 'x-tenant-id': TENANT_B },
        undefined,
        {
          serviceName: 'gateway-api',
          tenantId: TENANT_B,
          effectiveTenantId: TENANT_B,
          keyId: 'gateway-current',
          nonce: 'signed-auth-request',
          version: 'v2',
        },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBe(TENANT_B);
      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: TENANT_B,
          actedOnTenantId: TENANT_B,
          actorHomeTenantId: null,
        }),
      );
    });

    it('uses the HMAC-verified effective tenant without requiring a raw act-as header', async () => {
      const guard = createGuard({ mfaRequired: true });
      const context = createMockContext(
        superAdminUser({ tenantId: undefined, mfaVerified: true }),
        {},
        {
          issuer: 'gateway-api',
          subject: 'admin-001',
          tenantId: null,
          effectiveTenantId: TENANT_B,
          roles: [Role.SUPER_ADMIN],
          email: 'admin@example.com',
          mfaVerified: true,
          issuedAt: new Date().toISOString(),
          clientIp: '198.51.100.44',
          clientUserAgent: 'signed-client-agent',
        },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);

      const request = context.switchToHttp().getRequest<TenantRequest>();
      expect(request.tenantId).toBe(TENANT_B);
      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: TENANT_B,
          ip: '198.51.100.44',
          userAgent: 'signed-client-agent',
        }),
      );
    });

    it('rejects a conflicting raw act-as header when a verified assertion is present', async () => {
      const guard = createGuard({ mfaRequired: true });
      const context = createMockContext(
        superAdminUser({ tenantId: undefined, mfaVerified: true }),
        { 'x-act-as-tenant': TENANT_A },
        {
          issuer: 'gateway-api',
          subject: 'admin-001',
          tenantId: null,
          effectiveTenantId: TENANT_B,
          roles: [Role.SUPER_ADMIN],
          email: null,
          mfaVerified: true,
          issuedAt: new Date().toISOString(),
        },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBeUndefined();
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('rejects an assertion whose subject does not match the authenticated user', async () => {
      const guard = createGuard({ mfaRequired: true });
      const context = createMockContext(
        superAdminUser({ tenantId: undefined, mfaVerified: true }),
        {},
        {
          issuer: 'gateway-api',
          subject: 'different-admin',
          tenantId: null,
          effectiveTenantId: TENANT_B,
          roles: [Role.SUPER_ADMIN],
          email: null,
          mfaVerified: true,
          issuedAt: new Date().toISOString(),
        },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('requires the signed gateway tenant to match the assertion in production', async () => {
      const originalNodeEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const guard = createGuard({ mfaRequired: true });
        const context = createMockContext(
          superAdminUser({ tenantId: undefined, mfaVerified: true }),
          {},
          {
            issuer: 'gateway-api',
            subject: 'admin-001',
            tenantId: null,
            effectiveTenantId: TENANT_B,
            roles: [Role.SUPER_ADMIN],
            email: null,
            mfaVerified: true,
            issuedAt: new Date().toISOString(),
          },
          {
            serviceName: 'gateway-api',
            tenantId: TENANT_A,
            effectiveTenantId: TENANT_A,
            keyId: 'gateway-current',
            nonce: 'nonce-1',
            version: 'v2',
          },
        );

        await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
        expect(auditLogService.recordAwait).not.toHaveBeenCalled();
      } finally {
        if (originalNodeEnv === undefined) {
          delete process.env['NODE_ENV'];
        } else {
          process.env['NODE_ENV'] = originalNodeEnv;
        }
      }
    });
  });

  describe('production audit fail-closed', () => {
    it('rejects cross-tenant access when the persistent audit port is unavailable', async () => {
      const originalNodeEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const guard = createGuard({ withAudit: false, mfaRequired: true });
        const context = createMockContext(
          superAdminUser({ tenantId: undefined, mfaVerified: true }),
          { 'x-act-as-tenant': TENANT_B },
          undefined,
          {
            serviceName: 'gateway-api',
            tenantId: TENANT_B,
            effectiveTenantId: TENANT_B,
            keyId: 'gateway-current',
            nonce: 'nonce-2',
            version: 'v2',
          },
        );

        await expect(guard.canActivate(context)).rejects.toThrow(
          'Cross-tenant audit trail is unavailable',
        );
        expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBeUndefined();
      } finally {
        if (originalNodeEnv === undefined) {
          delete process.env['NODE_ENV'];
        } else {
          process.env['NODE_ENV'] = originalNodeEnv;
        }
      }
    });

    it('rejects cross-tenant access when the persistent audit append fails', async () => {
      const originalNodeEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      auditLogService.recordAwait.mockRejectedValueOnce(new Error('DB connection lost'));
      try {
        const guard = createGuard({ mfaRequired: true });
        const context = createMockContext(
          superAdminUser({ tenantId: undefined, mfaVerified: true }),
          { 'x-act-as-tenant': TENANT_B },
          undefined,
          {
            serviceName: 'gateway-api',
            tenantId: TENANT_B,
            effectiveTenantId: TENANT_B,
            keyId: 'gateway-current',
            nonce: 'nonce-3',
            version: 'v2',
          },
        );

        await expect(guard.canActivate(context)).rejects.toThrow(
          'Cross-tenant audit trail is unavailable',
        );
        expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBeUndefined();
      } finally {
        if (originalNodeEnv === undefined) {
          delete process.env['NODE_ENV'];
        } else {
          process.env['NODE_ENV'] = originalNodeEnv;
        }
      }
    });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  describe('edge cases', () => {
    it('should support deprecated "role" field for SUPER_ADMIN detection', async () => {
      const guard = createGuard();
      const user: JwtUser = {
        sub: 'admin-002',
        tenantId: TENANT_A,
        role: Role.SUPER_ADMIN,
      };
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(auditLogService.recordAwait).toHaveBeenCalledTimes(1);
    });

    it('should include email in audit record when available', async () => {
      const guard = createGuard();
      const user = superAdminUser({ email: 'admin@example.com' });
      const context = createMockContext(user, { 'x-act-as-tenant': TENANT_B });

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          userEmail: 'admin@example.com',
        }),
      );
    });
  });
});
