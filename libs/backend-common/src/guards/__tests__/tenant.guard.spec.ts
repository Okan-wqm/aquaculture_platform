import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AuditSeverity, type IAuditLogService } from '../../audit/audit-log.tokens';
import { IS_PUBLIC_KEY, SKIP_TENANT_GUARD_KEY, Role } from '../../decorators/roles.decorator';
import type {
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
  let auditLogService: jest.Mocked<IAuditLogService>;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;

  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';
  const IMPERSONATION_SESSION_ID = '33333333-3333-4333-8333-333333333333';
  const EFFECTIVE_PERMISSIONS = {
    canViewData: true,
    canModifyData: false,
    canAccessSettings: false,
    canManageUsers: false,
    canViewBilling: false,
    canExportData: false,
    allowedModules: ['farm'],
  } as const;

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

  const gatewayIdentity = (
    targetTenantId: string,
    overrides: Partial<VerifiedServiceIdentity> = {},
  ): VerifiedServiceIdentity => ({
    serviceName: 'gateway-api',
    tenantId: targetTenantId,
    effectiveTenantId: targetTenantId,
    keyId: 'gateway-current',
    nonce: 'canonical-impersonation-request',
    version: 'v2',
    ...overrides,
  });

  const impersonationAssertion = (
    user: JwtUser,
    targetTenantId: string,
    overrides: Partial<VerifiedUserAssertion> = {},
  ): VerifiedUserAssertion => ({
    issuer: 'gateway-api',
    subject: user.sub,
    tenantId: user.tenantId ?? null,
    effectiveTenantId: targetTenantId,
    roles: [Role.SUPER_ADMIN],
    email: user.email ?? null,
    mfaVerified: user.mfaVerified === true,
    issuedAt: new Date().toISOString(),
    assertionId: '33333333-3333-4333-8333-333333333333',
    impersonationSessionId: IMPERSONATION_SESSION_ID,
    impersonationPermissions: EFFECTIVE_PERMISSIONS,
    ...overrides,
  });

  const createImpersonationContext = (
    user: JwtUser,
    targetTenantId: string,
    headers: Record<string, string | undefined> = {},
    assertionOverrides: Partial<VerifiedUserAssertion> = {},
    identityOverrides: Partial<VerifiedServiceIdentity> = {},
  ): ExecutionContext =>
    createMockContext(
      user,
      headers,
      impersonationAssertion(user, targetTenantId, assertionOverrides),
      gatewayIdentity(targetTenantId, identityOverrides),
    );

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    auditLogService = {
      record: jest.fn(),
      recordAwait: jest.fn().mockResolvedValue(undefined),
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

    it('rejects a raw act-as header instead of treating it as tenant authority', async () => {
      const guard = createGuard();
      const context = createMockContext(superAdminUser(), { 'x-act-as-tenant': 'bad-uuid' });
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Raw act-as tenant headers cannot authorize cross-tenant access',
      );
    });
  });

  // -------------------------------------------------------------------
  // H-13 Part 1: Persistent audit logging for cross-tenant access
  // -------------------------------------------------------------------

  describe('H-13: persistent audit logging', () => {
    it('should call AuditLogService.recordAwait() for cross-tenant access (BULGU-4)', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B);

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).toHaveBeenCalledTimes(1);
      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUPER_ADMIN_CROSS_TENANT_ACCESS',
          resource: 'ImpersonationSession',
          resourceId: IMPERSONATION_SESSION_ID,
          userId: 'admin-001',
          tenantId: TENANT_B,
          severity: AuditSeverity.WARNING,
        }),
      );
      const auditEntry = auditLogService.recordAwait.mock.calls[0]?.[0];
      expect(auditEntry?.metadata).toMatchObject({
        sourceTenantId: TENANT_A,
        targetTenantId: TENANT_B,
        endpoint: 'GET /api/test',
        mfaVerified: false,
        impersonationSessionId: IMPERSONATION_SESSION_ID,
        effectivePermissions: EFFECTIVE_PERMISSIONS,
      });
    });

    it('should NOT call AuditLogService.recordAwait() when accessing own tenant', async () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: TENANT_A });
      const context = createImpersonationContext(user, TENANT_A);

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should prefer request.ip over X-Forwarded-For in audit record (BULGU-7)', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B, {
        'x-forwarded-for': '203.0.113.50, 10.0.0.1',
      });

      await guard.canActivate(context);

      // BULGU-7: request.ip is preferred because it respects trust proxy config
      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '127.0.0.1',
        }),
      );
    });

    it('should fall back to X-Forwarded-For when request.ip is unavailable', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      // Create context with no ip property to test X-Forwarded-For fallback
      const mockRequest = {
        user,
        headers: {
          'x-forwarded-for': '203.0.113.50, 10.0.0.1',
        } as Record<string, string | undefined>,
        verifiedUserAssertion: impersonationAssertion(user, TENANT_B),
        verifiedIdentity: gatewayIdentity(TENANT_B),
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

      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '203.0.113.50',
        }),
      );
    });

    it('should include user agent in audit record', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B, {
        'user-agent': 'Mozilla/5.0 TestBrowser',
      });

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'Mozilla/5.0 TestBrowser',
        }),
      );
    });

    it('should include mfaVerified=true in metadata when MFA is verified', async () => {
      const guard = createGuard();
      const user = superAdminUser({ mfaVerified: true });
      const context = createImpersonationContext(user, TENANT_B);

      await guard.canActivate(context);

      const auditEntry = auditLogService.recordAwait.mock.calls[0]?.[0];
      expect(auditEntry?.metadata).toMatchObject({ mfaVerified: true });
    });

    it('should use sourceTenantId "system" when SUPER_ADMIN has no tenantId', async () => {
      const guard = createGuard();
      const user = superAdminUser({ tenantId: undefined });
      const context = createImpersonationContext(user, TENANT_B);

      await guard.canActivate(context);

      const auditEntry = auditLogService.recordAwait.mock.calls[0]?.[0];
      expect(auditEntry?.metadata).toMatchObject({ sourceTenantId: 'system' });
    });

    it('should gracefully degrade when AuditLogService is not available', async () => {
      const guard = createGuard({ withAudit: false });
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B);

      // Should not throw — just logs ephemerally
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should set request.tenantId to target tenant after audit', async () => {
      const guard = createGuard();
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B);

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
      const context = createImpersonationContext(user, TENANT_B);

      // The guard should still return true despite the audit write failure
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should still set request.tenantId when audit write fails', async () => {
      auditLogService.recordAwait.mockRejectedValueOnce(new Error('DB connection lost'));
      const guard = createGuard();
      const user = superAdminUser();
      const context = createImpersonationContext(user, TENANT_B);

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
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should throw ForbiddenException when MFA is required but not verified', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException with descriptive message when MFA is missing', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).rejects.toThrow(/MFA verification is required/);
    });

    it('should throw ForbiddenException when MFA is required and mfaVerified is undefined', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser(); // no mfaVerified field
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should allow cross-tenant access when MFA is required and verified', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: true });
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(auditLogService.recordAwait).toHaveBeenCalledTimes(1);
    });

    it('should NOT require MFA for same-tenant access even if env var is set', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: TENANT_A, mfaVerified: false });
      const context = createImpersonationContext(user, TENANT_A);

      // Same tenant => no MFA check
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should NOT audit-log when MFA check fails (request is rejected)', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ mfaVerified: false });
      const context = createImpersonationContext(user, TENANT_B);

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
      const user = superAdminUser({ tenantId: undefined, mfaVerified: false });
      const context = createImpersonationContext(user, TENANT_B);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('signed effective-tenant assertion', () => {
    it('rejects a signed gateway tenant that omits the canonical impersonation assertion', async () => {
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

      await expect(guard.canActivate(context)).rejects.toThrow(
        'canonical verified impersonation assertion',
      );
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('uses the canonical HMAC-bound assertion without requiring a raw act-as header', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
      const context = createImpersonationContext(
        user,
        TENANT_B,
        {},
        {
          clientIp: '198.51.100.44',
          clientUserAgent: 'signed-client-agent',
        },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);

      const request = context.switchToHttp().getRequest<TenantRequest>();
      expect(request.tenantId).toBe(TENANT_B);
      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: IMPERSONATION_SESSION_ID,
          ip: '198.51.100.44',
          userAgent: 'signed-client-agent',
        }),
      );
    });

    it('rejects a cross-tenant assertion that omits session permission provenance', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
      const assertion = impersonationAssertion(user, TENANT_B);
      Reflect.deleteProperty(assertion, 'impersonationSessionId');
      Reflect.deleteProperty(assertion, 'impersonationPermissions');
      const context = createMockContext(user, {}, assertion, gatewayIdentity(TENANT_B));

      await expect(guard.canActivate(context)).rejects.toThrow('canonical impersonation assertion');
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('rejects an assertion without matching verified gateway transport identity', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
      const context = createMockContext(user, {}, impersonationAssertion(user, TENANT_B));

      await expect(guard.canActivate(context)).rejects.toThrow('verified gateway identity');
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('rejects every raw act-as header even when it matches the verified assertion', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
      const context = createImpersonationContext(user, TENANT_B, {
        'x-act-as-tenant': TENANT_B,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        'Raw act-as tenant header is not accepted downstream',
      );
      expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBeUndefined();
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('rejects an assertion whose subject does not match the authenticated user', async () => {
      const guard = createGuard({ mfaRequired: true });
      const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
      const context = createImpersonationContext(
        user,
        TENANT_B,
        {},
        {
          subject: 'different-admin',
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
            assertionId: '44444444-4444-4444-8444-444444444444',
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
        const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
        const context = createImpersonationContext(user, TENANT_B);

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
        const user = superAdminUser({ tenantId: undefined, mfaVerified: true });
        const context = createImpersonationContext(user, TENANT_B);

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
    it('does not treat the deprecated singular role claim as platform authority', async () => {
      const guard = createGuard();
      const user: JwtUser = {
        sub: 'admin-002',
        tenantId: TENANT_A,
        role: Role.SUPER_ADMIN,
      };
      const context = createMockContext(user);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(context.switchToHttp().getRequest<TenantRequest>().tenantId).toBe(TENANT_A);
      expect(auditLogService.recordAwait).not.toHaveBeenCalled();
    });

    it('should include email in audit record when available', async () => {
      const guard = createGuard();
      const user = superAdminUser({ email: 'admin@example.com' });
      const context = createImpersonationContext(user, TENANT_B);

      await guard.canActivate(context);

      expect(auditLogService.recordAwait).toHaveBeenCalledWith(
        expect.objectContaining({
          userEmail: 'admin@example.com',
        }),
      );
    });
  });
});
