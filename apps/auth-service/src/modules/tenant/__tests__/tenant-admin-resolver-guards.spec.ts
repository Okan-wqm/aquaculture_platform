import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { IAuditLogService } from '@aquaculture/backend-common/audit';
import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { TenantAdminResolver } from '../resolvers/tenant-admin.resolver';

/**
 * Verify that TenantAdminResolver methods have proper auth guards.
 *
 * NestJS SetMetadata stores metadata on the method function itself (not on
 * target + propertyKey). We retrieve the descriptor value to read it type-safely.
 */
describe('TenantAdminResolver — Guard Decorators', () => {
  function getMethodRoles(prototype: object, methodName: string): Role[] | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor?.value) return undefined;
    return Reflect.getMetadata(ROLES_KEY, descriptor.value as object) as Role[] | undefined;
  }

  it('myModules should require at least MODULE_USER role', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'myModules');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.MODULE_USER);
    expect(roles).toContain(Role.MODULE_MANAGER);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).toContain(Role.SUPER_ADMIN);
  });

  it('moduleUsers should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'moduleUsers');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('userAssignedSiteIds should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'userAssignedSiteIds');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_MANAGER);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  // SEC-HIGH-051: the new site-assignment write-path must carry the SAME
  // TenantAdminOrHigher gate as the module-assignment management precedent.
  it('assignUserToSite should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'assignUserToSite');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_MANAGER);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('unassignUserFromSite should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'unassignUserFromSite');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('rejects an MFA-unverified SUPER_ADMIN site-assignment mutation from a signed effective tenant', async () => {
    const targetTenantId = '22222222-2222-4222-8222-222222222222';
    const audit: IAuditLogService = {
      record: jest.fn(),
      recordAwait: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new TenantGuard(
      new Reflector(),
      audit,
      new ConfigService({ MFA_REQUIRED_FOR_CROSS_TENANT: 'true' }),
    );
    const request = {
      headers: { 'x-tenant-id': targetTenantId },
      method: 'POST',
      url: '/graphql',
      user: {
        sub: 'platform-admin',
        roles: [Role.SUPER_ADMIN],
        mfaVerified: false,
      },
      verifiedIdentity: {
        serviceName: 'gateway-api',
        tenantId: targetTenantId,
        effectiveTenantId: targetTenantId,
        keyId: 'gateway-current',
        nonce: 'signed-request-nonce',
        version: 'v2' as const,
      },
    };
    const context = new ExecutionContextHost(
      [request],
      TenantAdminResolver,
      TenantAdminResolver.prototype.assignUserToSite,
    );
    context.setType('http');

    await expect(guard.canActivate(context)).rejects.toThrow('MFA verification is required');
    expect(audit.recordAwait).not.toHaveBeenCalled();
  });

  it('wires the auth audit SSoT into the global TenantGuard provider', () => {
    const appModuleSource = readFileSync(resolve(__dirname, '../../../app.module.ts'), 'utf8');

    expect(appModuleSource).toMatch(
      /new TenantGuard\(reflector,\s*auditLogService,\s*configService\)/,
    );
    expect(appModuleSource).toMatch(
      /inject:\s*\[Reflector,\s*AUDIT_LOG_SERVICE,\s*ConfigService\]/,
    );
  });
});
