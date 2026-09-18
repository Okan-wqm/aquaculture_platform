import 'reflect-metadata';
import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';

import { AuditLogService } from '../../../audit/audit-log.service';
import { UpdateTenantInput } from '../dto/create-tenant.dto';
import { TenantResolver } from '../resolvers/tenant.resolver';
import { TenantProvisioningCommandService } from '../services/tenant-provisioning-command.service';
import { TenantService } from '../services/tenant.service';

/**
 * Verify the updateTenant mutation consolidation.
 *
 * Tenant mutation authority converged on the command-receipt/FSM path
 * (enterprise train). The resolver-level updateTenant now REJECTS outright —
 * stronger than role-based field filtering, because nothing mutates tenants
 * outside the governed command path. These tests pin that refusal.
 */
/**
 * W5: `auth.tenants` yazımı command-receipt yolundadır; generic updateTenant
 * yine reddeder. Bu stub yalnız lokalizasyon mutation'ının bağımlılığını
 * karşılar — `Partial<T> → T` daraltması repo genelindeki spec kalıbıdır.
 */
function tenantCommandsStub(): TenantProvisioningCommandService {
  const impl: Partial<TenantProvisioningCommandService> = {
    updateTenantLocalization: jest.fn(),
  };
  return impl as TenantProvisioningCommandService;
}

describe('Tenant Update Consolidation', () => {
  describe('TenantResolver mutations', () => {
    it('should NOT have updateTenantSettings method', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        TenantResolver.prototype,
        'updateTenantSettings',
      );
      expect(descriptor).toBeUndefined();
    });

    it('should have updateTenant method', () => {
      expect(TenantResolver.prototype.updateTenant).toBeDefined();
    });
  });

  describe('updateTenant — command-receipt ownership (FSM path)', () => {
    it('rejects even SUPER_ADMIN with a command-path redirect (no service call)', () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
        // W5: `auth.tenants` yazımı command-receipt yolundadır; generic
        // updateTenant yine reddeder — bu bağımlılık lokalizasyon
        // mutation'ı içindir.
        tenantCommandsStub(),
      );

      expect(() =>
        resolver.updateTenant('any-tenant', { name: 'X' }, Role.SUPER_ADMIN, null),
      ).toThrow(BadRequestException);
      expect(() =>
        resolver.updateTenant('any-tenant', { name: 'X' }, Role.SUPER_ADMIN, null),
      ).toThrow(/command-receipt owned/);
      expect(mockTenantService.update).not.toHaveBeenCalled();
    });

    it('still enforces tenant isolation FIRST — TENANT_ADMIN on another tenant gets 403', () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
        // W5: `auth.tenants` yazımı command-receipt yolundadır; generic
        // updateTenant yine reddeder — bu bağımlılık lokalizasyon
        // mutation'ı içindir.
        tenantCommandsStub(),
      );

      expect(() =>
        resolver.updateTenant(
          'other-tenant-id',
          { name: 'Hack' },
          Role.TENANT_ADMIN,
          'my-tenant-id',
        ),
      ).toThrow(ForbiddenException);
      expect(mockTenantService.update).not.toHaveBeenCalled();
    });

    it('rejects TENANT_ADMIN on their OWN tenant too (command path only)', () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
        // W5: `auth.tenants` yazımı command-receipt yolundadır; generic
        // updateTenant yine reddeder — bu bağımlılık lokalizasyon
        // mutation'ı içindir.
        tenantCommandsStub(),
      );

      expect(() =>
        resolver.updateTenant(
          'my-tenant-id',
          { name: 'Renamed' },
          Role.TENANT_ADMIN,
          'my-tenant-id',
        ),
      ).toThrow(BadRequestException);
      expect(mockTenantService.update).not.toHaveBeenCalled();
    });
  });

  describe('UpdateTenantInput allow-list (HIGH-005 / MT-HIGH-001 tail)', () => {
    // The validated property set IS the security boundary: ValidationPipe runs
    // with whitelist + forbidNonWhitelisted, so a field absent here is rejected
    // even if a @Field decorator were re-added. Pin that governance/billing
    // fields can never re-enter the tenant-self-service update surface.
    const validatedProps = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdateTenantInput, '', false, false)
        .map((m) => m.propertyName),
    );

    it.each(['status', 'plan', 'maxUsers'])(
      'does NOT expose the governance/billing field "%s"',
      (forbidden) => {
        expect(validatedProps.has(forbidden)).toBe(false);
      },
    );

    it('retains the self-service profile fields', () => {
      for (const allowed of ['name', 'description', 'contactEmail', 'address']) {
        expect(validatedProps.has(allowed)).toBe(true);
      }
    });
  });
});
