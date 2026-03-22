import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
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

  describe('TenantService.update role-based filtering', () => {
    it('should call TenantService.update with role parameter', async () => {
      // Create a minimal resolver instance with mock services
      const mockTenantService = {
        update: jest.fn().mockResolvedValue({
          id: 'tenant-1',
          name: 'Updated',
          slug: 'updated',
          status: 'active',
        }),
      };
      const mockAuditLogService = {
        findByTenant: jest.fn(),
      };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
      );

      await resolver.updateTenant(
        'tenant-1',
        { name: 'Updated' },
        Role.TENANT_ADMIN,
        'tenant-1',
      );

      // Should pass the role to the service
      expect(mockTenantService.update).toHaveBeenCalledWith(
        'tenant-1',
        { name: 'Updated' },
        Role.TENANT_ADMIN,
      );
    });

    it('should enforce tenant isolation — TENANT_ADMIN cannot update other tenant', async () => {
      const mockTenantService = { update: jest.fn() };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
      );

      await expect(
        resolver.updateTenant(
          'other-tenant-id',
          { name: 'Hack' },
          Role.TENANT_ADMIN,
          'my-tenant-id',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockTenantService.update).not.toHaveBeenCalled();
    });

    it('should allow SUPER_ADMIN to update any tenant', async () => {
      const mockTenantService = {
        update: jest.fn().mockResolvedValue({ id: 'any-tenant', name: 'X' }),
      };
      const mockAuditLogService = { findByTenant: jest.fn() };

      const resolver = new TenantResolver(
        mockTenantService as unknown as TenantService,
        mockAuditLogService as unknown as AuditLogService,
      );

      await resolver.updateTenant(
        'any-tenant',
        { name: 'X' },
        Role.SUPER_ADMIN,
        null,
      );

      expect(mockTenantService.update).toHaveBeenCalledWith(
        'any-tenant',
        { name: 'X' },
        Role.SUPER_ADMIN,
      );
    });
  });
});
