import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Role } from '@platform/identity';

import {
  IS_ADMIN_KEY,
  IS_PUBLIC_KEY,
  TenantIsolationGuard,
  type TenantIsolationRequest,
  type TenantIsolationUser,
} from '../tenant-isolation.guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

interface ContextOptions {
  readonly user?: TenantIsolationUser;
  readonly effectiveTenantId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

function executionContext(options: ContextOptions = {}): {
  readonly context: ExecutionContext;
  readonly request: TenantIsolationRequest;
} {
  const request = {
    user: options.user,
    effectiveTenantId: options.effectiveTenantId,
    headers: { ...(options.headers ?? {}) },
    params: { ...(options.params ?? {}) },
    query: { ...(options.query ?? {}) },
  } satisfies TenantIsolationRequest & {
    readonly headers: Readonly<Record<string, string>>;
    readonly params: Readonly<Record<string, string>>;
    readonly query: Readonly<Record<string, string>>;
  };
  const context = new ExecutionContextHost(
    [request],
    TenantIsolationGuard,
    executionContext,
  );
  context.setType('http');
  return { context, request };
}

function tenantUser(tenantId = TENANT_A): TenantIsolationUser {
  return {
    sub: 'tenant-user',
    tenantId,
    roles: [Role.MODULE_USER],
    modules: [],
  };
}

function superAdmin(): TenantIsolationUser {
  return {
    sub: 'platform-admin',
    tenantId: null,
    roles: [Role.SUPER_ADMIN],
    modules: [],
  };
}

describe('TenantIsolationGuard authority boundary', () => {
  let publicRoute = false;
  let adminRoute = false;
  let guard: TenantIsolationGuard;

  beforeEach(() => {
    publicRoute = false;
    adminRoute = false;
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
        if (key === IS_PUBLIC_KEY) return publicRoute;
        if (key === IS_ADMIN_KEY) return adminRoute;
        return false;
      });
    guard = new TenantIsolationGuard(reflector);
  });

  it('allows a public route without identity or tenant context', () => {
    publicRoute = true;
    expect(guard.canActivate(executionContext().context)).toBe(true);
  });

  it('requires authentication on a protected route', () => {
    expect(() => guard.canActivate(executionContext().context)).toThrow(UnauthorizedException);
  });

  it('uses the verified JWT tenant when middleware did not need an override', () => {
    const { context, request } = executionContext({ user: tenantUser() });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.tenantId).toBe(TENANT_A);
    expect(request.tenantContext?.tenantId).toBe(TENANT_A);
  });

  it('never reinterprets raw headers, params, or queries as tenant authority', () => {
    const { context, request } = executionContext({
      user: tenantUser(),
      headers: { 'x-tenant-id': TENANT_B },
      params: { tenantId: TENANT_B },
      query: { tenantId: TENANT_B },
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.tenantId).toBe(TENANT_A);
  });

  it('rejects a divergent effective tenant for a regular account', () => {
    const { context } = executionContext({
      user: tenantUser(),
      effectiveTenantId: TENANT_B,
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('accepts the authority-resolved tenant for a canonical SUPER_ADMIN', () => {
    const { context, request } = executionContext({
      user: superAdmin(),
      effectiveTenantId: TENANT_B,
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.tenantId).toBe(TENANT_B);
  });

  it('rejects a tenant-scoped SUPER_ADMIN request without an authority result', () => {
    const { context } = executionContext({ user: superAdmin() });
    expect(() => guard.canActivate(context)).toThrow('A validated tenant context is required');
  });

  it('does not grant authority to a legacy lower-case role alias', () => {
    const { context } = executionContext({
      user: { sub: 'legacy', tenantId: null, roles: ['super_admin'] },
      effectiveTenantId: TENANT_B,
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows canonical SUPER_ADMIN system scope only on an explicit admin route', () => {
    adminRoute = true;
    expect(guard.canActivate(executionContext({ user: superAdmin() }).context)).toBe(true);
  });

  it('rejects a malformed authority result', () => {
    const { context } = executionContext({
      user: superAdmin(),
      effectiveTenantId: 'not-a-uuid',
    });
    expect(() => guard.canActivate(context)).toThrow('Invalid tenant context');
  });

  it('exposes only the resolved request context through static helpers', () => {
    const { context, request } = executionContext({ user: tenantUser() });
    guard.canActivate(context);
    expect(TenantIsolationGuard.getTenantId(request)).toBe(TENANT_A);
    expect(TenantIsolationGuard.getTenantContext(request)?.tenantId).toBe(TENANT_A);
  });
});
