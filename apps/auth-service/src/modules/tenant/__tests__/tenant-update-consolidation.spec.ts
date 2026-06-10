import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@platform/backend-common';

import { TenantResolver } from '../resolvers/tenant.resolver';
import { TenantService } from '../services/tenant.service';
import { AuditLogService } from '../../../audit/audit-log.service';

/**
 * Verify the updateTenant mutation consolidation:
 * 1. updateTenantSettings mutation is removed from resolver
 * 2. updateTenant applies role-based filtering via TenantService.update(id, input, role)
 */
describe('Tenant Update Consolidation', () => {
  describe('TenantResolver mutations', () => {
    it('should NOT have updateTenantSettings method', () => {
      // The standalone updateTenantSettings mutation has been removed
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
    // WHY rewritten: tenant mutation authority converged on the
    // command-receipt/FSM path (enterprise train). The resolver-level
    // update now REJECTS outright — stronger than the previous role-based
    // field filtering, because nothing mutates tenants outside the governed
    // command path. These tests pin that refusal.

    it('rejects even SUPER_ADMIN with a command-path redirect (no service call)', () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
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
      );

      expect(() =>
        resolver.updateTenant('other-tenant-id', { name: 'Hack' }, Role.TENANT_ADMIN, 'my-tenant-id'),
      ).toThrow(ForbiddenException);
      expect(mockTenantService.update).not.toHaveBeenCalled();
    });

    it('rejects TENANT_ADMIN on their OWN tenant too (command path only)', () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
      );

      expect(() =>
        resolver.updateTenant('my-tenant-id', { name: 'Renamed' }, Role.TENANT_ADMIN, 'my-tenant-id'),
      ).toThrow(BadRequestException);
      expect(mockTenantService.update).not.toHaveBeenCalled();
    });
  });
});

