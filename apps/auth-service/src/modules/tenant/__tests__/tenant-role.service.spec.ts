 
 
 
 
 
 
 
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryRunner } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { CapabilityAuthorityService } from '../services/capability-authority';
import { TenantRoleService } from '../services/tenant-role.service';

// ============================================================================
// Constants
// ============================================================================

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ROLE_ID = 'role-uuid-001';
const USER_ID = 'user-uuid-001';
const ADMIN_USER_ID = 'admin-uuid-001';

// ============================================================================
// Mock QueryRunner Factory
// ============================================================================

const createMockQueryRunner = (): jest.Mocked<
  Pick<QueryRunner, 'connect' | 'startTransaction' | 'commitTransaction' | 'rollbackTransaction' | 'release' | 'query'>
> & { manager: { create: jest.Mock; save: jest.Mock } } => ({
  connect: jest.fn().mockResolvedValue(undefined),
  startTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue([]),
  // A real QueryRunner exposes `.manager` (the transaction-bound EntityManager)
  // that RBAC-C3 threads into AuditLogService.log for an atomic audit write.
  manager: {
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
  },
});

// ============================================================================
// Mock Role Row Factory
// ============================================================================

const createMockRoleRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ROLE_ID,
  name: 'Test Role',
  description: 'A test role',
  color: '#6366F1',
  icon: 'shield',
  level: 50,
  is_system: false,
  is_default: false,
  user_count: 0,
  permission_id: 'perm-uuid-001',
  panel_permissions: JSON.stringify({ farm: { sites: { view: true, create: false } } }),
  resource_permissions: ['sites:view'],
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('TenantRoleService', () => {
  let service: TenantRoleService;
  let mockDataSource: jest.Mocked<Pick<DataSource, 'query' | 'createQueryRunner'>>;
  let mockQueryRunner: ReturnType<typeof createMockQueryRunner>;
  let mockAuditLogService: { log: jest.Mock };

  beforeEach(async () => {
    mockQueryRunner = createMockQueryRunner();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantRoleService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: AuditLogService, useValue: mockAuditLogService },
        {
          // Default: an admin author who may grant any catalogue capability;
          // the validator passes the derived resource permissions through. Tests
          // that exercise delegate containment override these mocks.
          provide: CapabilityAuthorityService,
          useValue: {
            resolveActorAuthority: jest.fn().mockResolvedValue({
              isTenantAdmin: true,
              effective: new Set<string>(),
            }),
            assertGrantableResourcePermissions: jest.fn((requested: string[]) => requested),
            assertGrantableOverrides: jest.fn((o: { grants?: string[]; revokes?: string[] } | null) => ({
              grants: o?.grants ?? [],
              revokes: o?.revokes ?? [],
            })),
            emptyOverrides: jest.fn(() => ({ grants: [], revokes: [] })),
          },
        },
      ],
    }).compile();

    service = module.get<TenantRoleService>(TenantRoleService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // getTenantRoles
  // ==========================================================================

  describe('getTenantRoles', () => {
    it('should return all roles for a tenant', async () => {
      const rows = [
        createMockRoleRow({ id: 'role-1', name: 'Supervisor', level: 70 }),
        createMockRoleRow({ id: 'role-2', name: 'Operator', level: 30 }),
      ];
      mockDataSource.query.mockResolvedValue(rows);

      const result = await service.getTenantRoles(TENANT_ID);

      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('Supervisor');
      expect(result[1]!.name).toBe('Operator');
      // Repointed: query targets auth.* and binds tenantId as $1.
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('"auth"."tenant_roles"'),
        [TENANT_ID],
      );
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE r."tenantId" = $1'),
        [TENANT_ID],
      );
    });

    it('should correctly map role row including permissions', async () => {
      const panelPerms = { farm: { sites: { view: true } } };
      const row = createMockRoleRow({
        panel_permissions: JSON.stringify(panelPerms),
        resource_permissions: ['sites:view', 'tanks:view'],
        user_count: 5,
      });
      mockDataSource.query.mockResolvedValue([row]);

      const result = await service.getTenantRoles(TENANT_ID);

      expect(result[0]!.permissions).not.toBeNull();
      expect(result[0]!.permissions!.panelPermissions).toEqual(panelPerms);
      expect(result[0]!.permissions!.resourcePermissions).toEqual(['sites:view', 'tanks:view']);
      expect(result[0]!.userCount).toBe(5);
    });

    it('should handle role without permissions (permission_id null)', async () => {
      const row = createMockRoleRow({
        permission_id: null,
        panel_permissions: null,
        resource_permissions: null,
      });
      mockDataSource.query.mockResolvedValue([row]);

      const result = await service.getTenantRoles(TENANT_ID);

      expect(result[0]!.permissions).toBeNull();
    });

    it('should scope the user_count subquery to the tenant via a join on tenant_roles', async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.getTenantRoles(TENANT_ID);

      const [sql] = mockDataSource.query.mock.calls[0]!;
      expect(sql).toContain('JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $1');
    });
  });

  // ==========================================================================
  // getRoleById
  // ==========================================================================

  describe('getRoleById', () => {
    it('should return a role by ID scoped to tenant', async () => {
      mockDataSource.query.mockResolvedValue([createMockRoleRow()]);

      const result = await service.getRoleById(TENANT_ID, ROLE_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(ROLE_ID);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE r.id = $1 AND r."tenantId" = $2'),
        [ROLE_ID, TENANT_ID],
      );
    });

    it('should return null when role does not exist in tenant', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.getRoleById(TENANT_ID, 'non-existent-id');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // getDefaultRole
  // ==========================================================================

  describe('getDefaultRole', () => {
    it('should return the default role scoped to tenant', async () => {
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ is_default: true, name: 'Operator' }),
      ]);

      const result = await service.getDefaultRole(TENANT_ID);

      expect(result).not.toBeNull();
      expect(result!.isDefault).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE r.is_default = true AND r."tenantId" = $1'),
        [TENANT_ID],
      );
    });

    it('should return null when no default role is set', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.getDefaultRole(TENANT_ID);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // seedDefaultRoles
  // ==========================================================================

  describe('seedDefaultRoles', () => {
    it('should create 5 default roles with SERIALIZABLE transaction', async () => {
      // First call: count existing = 0
      mockQueryRunner.query
        .mockResolvedValueOnce([{ count: 0 }]); // COUNT check

      // For each of 5 roles: INSERT RETURNING id + INSERT permissions
      for (let i = 0; i < 5; i++) {
        mockQueryRunner.query
          .mockResolvedValueOnce([{ id: `default-role-${i}` }]) // role INSERT
          .mockResolvedValueOnce([]); // permission INSERT
      }

      // After commit, getTenantRoles is called which uses dataSource.query
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ name: 'Supervisor' }),
        createMockRoleRow({ name: 'Technician' }),
        createMockRoleRow({ name: 'Feed Manager' }),
        createMockRoleRow({ name: 'Operator' }),
        createMockRoleRow({ name: 'Viewer' }),
      ]);

      const result = await service.seedDefaultRoles(TENANT_ID, ADMIN_USER_ID);

      expect(result).toHaveLength(5);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should scope the existence check to the tenant and prepend tenantId on INSERT', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([{ count: 0 }]);
      for (let i = 0; i < 5; i++) {
        mockQueryRunner.query
          .mockResolvedValueOnce([{ id: `default-role-${i}` }])
          .mockResolvedValueOnce([]);
      }
      mockDataSource.query.mockResolvedValue([]);

      await service.seedDefaultRoles(TENANT_ID, ADMIN_USER_ID);

      // Existence check scoped to tenant and bound (not interpolated)
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WHERE "tenantId" = $1'),
        [TENANT_ID],
      );
      // First role INSERT (2nd query overall) prepends "tenantId" as $1
      const insertCall = mockQueryRunner.query.mock.calls[1]!;
      expect(insertCall[0]).toContain('INSERT INTO "auth"."tenant_roles"');
      expect(insertCall[0]).toContain('"tenantId"');
      expect((insertCall[1] as unknown[])[0]).toBe(TENANT_ID);
    });

    it('should skip seeding if roles already exist', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([{ count: 3 }]);

      // After commit, getTenantRoles is called
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ name: 'Existing1' }),
        createMockRoleRow({ name: 'Existing2' }),
        createMockRoleRow({ name: 'Existing3' }),
      ]);

      const result = await service.seedDefaultRoles(TENANT_ID, ADMIN_USER_ID);

      expect(result).toHaveLength(3);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // Should NOT have inserted any roles (only the COUNT query ran)
      expect(mockQueryRunner.query).toHaveBeenCalledTimes(1);
    });

    it('should rollback transaction on error during seeding', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ count: 0 }]) // COUNT check
        .mockRejectedValueOnce(new Error('DB connection lost')); // first role INSERT fails

      await expect(service.seedDefaultRoles(TENANT_ID, ADMIN_USER_ID)).rejects.toThrow(
        'DB connection lost',
      );

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should use FOR UPDATE lock on COUNT query to prevent race conditions', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([{ count: 0 }]);

      // Stub remaining calls for 5 roles
      for (let i = 0; i < 5; i++) {
        mockQueryRunner.query
          .mockResolvedValueOnce([{ id: `role-${i}` }])
          .mockResolvedValueOnce([]);
      }
      mockDataSource.query.mockResolvedValue([]);

      await service.seedDefaultRoles(TENANT_ID, ADMIN_USER_ID);

      // Verify the first query contains FOR UPDATE
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FOR UPDATE'),
        [TENANT_ID],
      );
    });
  });

  // ==========================================================================
  // createRole
  // ==========================================================================

  describe('createRole', () => {
    const createInput = {
      name: 'Custom Role',
      description: 'A custom role',
      color: '#FF0000',
      icon: 'star',
      level: 60,
      isDefault: false,
      panelPermissions: { farm: { sites: { view: true, create: true } } },
    };

    it('should create a custom role with SERIALIZABLE transaction', async () => {
      // Duplicate check returns empty
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-role-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions

      // getRoleById after commit
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ id: 'new-role-id', name: 'Custom Role' }),
      ]);

      const result = await service.createRole(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(result.name).toBe('Custom Role');
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('RBAC-C3: writes a ROLE_CREATED audit row on the transaction manager (fail-closed)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-role-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions
      mockDataSource.query.mockResolvedValue([createMockRoleRow({ id: 'new-role-id', name: 'Custom Role' })]);

      await service.createRole(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          performedBy: ADMIN_USER_ID,
          action: 'ROLE_CREATED',
          entityType: 'TenantRole',
          entityId: 'new-role-id',
        }),
        // manager-threaded (2nd arg) so the audit is atomic with the insert.
        expect.anything(),
      );
    });

    it('RBAC-C3: an audit failure ROLLS BACK the role creation (fail-closed)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-role-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(service.createRole(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow('audit DB down');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('should throw ConflictException for duplicate role name', async () => {
      // Duplicate check returns existing
      mockQueryRunner.query.mockResolvedValueOnce([{ id: 'existing-id' }]);

      await expect(
        service.createRole(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should use case-insensitive, tenant-scoped duplicate check with FOR UPDATE', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions

      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ id: 'new-id', name: 'Custom Role' }),
      ]);

      await service.createRole(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('LOWER(name) = LOWER($1) AND "tenantId" = $2'),
        [createInput.name, TENANT_ID],
      );
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FOR UPDATE'),
        expect.any(Array),
      );
    });

    it('should unset other defaults (scoped to tenant) when creating a default role', async () => {
      const defaultInput = { ...createInput, isDefault: true };

      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([]) // UPDATE unset defaults
        .mockResolvedValueOnce([{ id: 'new-default-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions

      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ id: 'new-default-id', is_default: true }),
      ]);

      await service.createRole(TENANT_ID, defaultInput, ADMIN_USER_ID);

      // Second query should be the UPDATE to unset defaults, scoped to tenant
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('SET is_default = false'),
        [TENANT_ID],
      );
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('WHERE is_default = true AND "tenantId" = $1'),
        [TENANT_ID],
      );
    });

    it('should use default color and icon when not provided', async () => {
      const minimalInput = {
        name: 'Minimal Role',
        panelPermissions: {},
      };

      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'min-role-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions

      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ id: 'min-role-id', name: 'Minimal Role' }),
      ]);

      await service.createRole(TENANT_ID, minimalInput, ADMIN_USER_ID);

      // The INSERT query should use default values; tenantId is the leading param
      const insertCall = mockQueryRunner.query.mock.calls[1];
      const insertParams = insertCall![1];
      expect((insertParams as unknown[])[0]).toBe(TENANT_ID); // tenantId prepended
      expect(insertParams).toContain('#6366F1'); // default color
      expect(insertParams).toContain('shield'); // default icon
    });

    it('should rollback on INSERT failure', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockRejectedValueOnce(new Error('INSERT failed'));

      await expect(
        service.createRole(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow('INSERT failed');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should always release queryRunner even on error', async () => {
      mockQueryRunner.query.mockRejectedValue(new Error('any error'));

      await expect(
        service.createRole(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow();

      expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // updateRole
  // ==========================================================================

  describe('updateRole', () => {
    it('should update role name and level for non-system role', async () => {
      // Lock and fetch existing
      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow({ is_system: false })]) // existing with lock
        .mockResolvedValueOnce([]) // duplicate name check
        .mockResolvedValueOnce([]); // UPDATE role

      // getRoleById after commit
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ name: 'Updated Name', level: 80 }),
      ]);

      const result = await service.updateRole(
        TENANT_ID,
        ROLE_ID,
        { name: 'Updated Name', level: 80 },
        ADMIN_USER_ID,
      );

      expect(result.name).toBe('Updated Name');
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // Lock-load is tenant-scoped
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WHERE r.id = $1 AND r."tenantId" = $2'),
        [ROLE_ID, TENANT_ID],
      );
    });

    it('should append the tenant guard to the dynamic UPDATE with correct param indices', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow({ is_system: false })]) // existing
        .mockResolvedValueOnce([]) // duplicate name check
        .mockResolvedValueOnce([]); // dynamic UPDATE

      mockDataSource.query.mockResolvedValue([createMockRoleRow()]);

      await service.updateRole(
        TENANT_ID,
        ROLE_ID,
        { name: 'Renamed', level: 80 },
        ADMIN_USER_ID,
      );

      // Find the dynamic UPDATE on tenant_roles (not the permissions update)
      const updateCall = mockQueryRunner.query.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('UPDATE "auth"."tenant_roles"') &&
          c[0].includes('WHERE id ='),
      );
      expect(updateCall).toBeDefined();
      // name=$1, level=$2, then id=$3 and "tenantId"=$4
      expect(updateCall![0]).toContain('WHERE id = $3 AND "tenantId" = $4');
      const params = updateCall![1] as unknown[];
      expect(params[params.length - 2]).toBe(ROLE_ID);
      expect(params[params.length - 1]).toBe(TENANT_ID);
    });

    it('should throw ForbiddenException when modifying name of system role', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        createMockRoleRow({ is_system: true }),
      ]);

      await expect(
        service.updateRole(TENANT_ID, ROLE_ID, { name: 'New Name' }, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw ForbiddenException when modifying level of system role', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        createMockRoleRow({ is_system: true }),
      ]);

      await expect(
        service.updateRole(TENANT_ID, ROLE_ID, { level: 99 }, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow updating description and color of system role', async () => {
      // System role but only updating description and color (allowed)
      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow({ is_system: true })]) // existing
        .mockResolvedValueOnce([]); // UPDATE

      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ is_system: true, description: 'Updated desc', color: '#00FF00' }),
      ]);

      const result = await service.updateRole(
        TENANT_ID,
        ROLE_ID,
        { description: 'Updated desc', color: '#00FF00' },
        ADMIN_USER_ID,
      );

      expect(result).toBeDefined();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should throw NotFoundException when role does not exist', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]); // no existing role

      await expect(
        service.updateRole(TENANT_ID, 'non-existent-id', { name: 'New' }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException for duplicate name on update', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow({ name: 'Old Name' })]) // existing
        .mockResolvedValueOnce([{ id: 'other-role' }]); // duplicate found

      await expect(
        service.updateRole(TENANT_ID, ROLE_ID, { name: 'Existing Name' }, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('should update permissions via write-side join when panelPermissions provided', async () => {
      const newPerms = { operations: { sensors: { view: true, configure: true } } };

      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow()]) // existing
        .mockResolvedValueOnce([]) // UPDATE role fields
        .mockResolvedValueOnce([]); // UPDATE permissions

      mockDataSource.query.mockResolvedValue([createMockRoleRow()]);

      await service.updateRole(
        TENANT_ID,
        ROLE_ID,
        { panelPermissions: newPerms },
        ADMIN_USER_ID,
      );

      // Verify that one of the queryRunner calls UPDATEs tenant_role_permissions.
      // (The lock-load SELECT also references panel_permissions, so match on the
      // UPDATE statement specifically.)
      const permUpdateCall = mockQueryRunner.query.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE "auth"."tenant_role_permissions" trp'),
      );
      expect(permUpdateCall).toBeDefined();
      // The SQL should be an UPDATE on tenant_role_permissions through a join on tenant_roles
      expect(permUpdateCall![0]).toContain('panel_permissions');
      expect(permUpdateCall![0]).toContain('resource_permissions');
      expect(permUpdateCall![0]).toContain('FROM "auth"."tenant_roles" tr');
      expect(permUpdateCall![0]).toContain('tr."tenantId" = $4');
      expect(permUpdateCall![1]).toEqual([
        JSON.stringify(newPerms),
        expect.any(Array),
        ROLE_ID,
        TENANT_ID,
      ]);
    });
  });

  // ==========================================================================
  // deleteRole
  // ==========================================================================

  describe('deleteRole', () => {
    it('should delete a custom role with no assigned users', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Custom', is_system: false, user_count: 0 }]) // lock + fetch
        .mockResolvedValueOnce([]) // DELETE permissions
        .mockResolvedValueOnce([]); // DELETE role

      const result = await service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // Role DELETE carries its own tenant guard
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('DELETE FROM "auth"."tenant_roles" WHERE id = $1 AND "tenantId" = $2'),
        [ROLE_ID, TENANT_ID],
      );
    });

    it('RBAC-C3: writes a ROLE_DELETED audit row snapshotting the role (fail-closed)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Custom', is_system: false, is_default: false, level: 40, user_count: 0 }])
        .mockResolvedValueOnce([]) // DELETE permissions
        .mockResolvedValueOnce([]); // DELETE role

      await service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ROLE_DELETED',
          entityType: 'TenantRole',
          entityId: ROLE_ID,
          performedBy: ADMIN_USER_ID,
          previousValue: expect.objectContaining({ name: 'Custom' }),
        }),
        expect.anything(),
      );
    });

    it('should throw ForbiddenException when deleting system role', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        { id: ROLE_ID, name: 'Supervisor', is_system: true, user_count: 0 },
      ]);

      await expect(
        service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw ForbiddenException when role has assigned users', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        { id: ROLE_ID, name: 'Custom', is_system: false, user_count: 3 },
      ]);

      try {
        await service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);
        // Should not reach here
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect(e.message).toContain('3 users');
      }
    });

    it('should throw NotFoundException when role does not exist', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]);

      await expect(
        service.deleteRole(TENANT_ID, 'non-existent', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should delete permissions before deleting the role', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Custom', is_system: false, user_count: 0 }])
        .mockResolvedValueOnce([]) // DELETE permissions
        .mockResolvedValueOnce([]); // DELETE role

      await service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);

      // Verify order: permissions deleted before role
      const calls = mockQueryRunner.query.mock.calls;
      const permDeleteIndex = calls.findIndex(
        (c) => typeof c[0] === 'string' && c[0].includes('tenant_role_permissions'),
      );
      const roleDeleteIndex = calls.findIndex(
        (c) => typeof c[0] === 'string' && c[0].includes('DELETE') && c[0].includes('tenant_roles') && !c[0].includes('tenant_role_permissions'),
      );
      expect(permDeleteIndex).toBeLessThan(roleDeleteIndex);
    });
  });

  // ==========================================================================
  // assignRoleToUser
  // ==========================================================================

  describe('assignRoleToUser', () => {
    it('should create a new role assignment when the user holds no role', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user pre-validation: in tenant
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: true }]) // role exists in tenant
        .mockResolvedValueOnce([]) // no existing assignment for this user
        .mockResolvedValueOnce([{ id: 'assignment-001' }]); // INSERT assignment

      const result = await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.userId).toBe(USER_ID);
      expect(result.roleId).toBe(ROLE_ID);
      expect(result.isActive).toBe(true);
      expect(result.id).toBe('assignment-001');
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should validate the user is in the tenant before touching assignments', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'new-assignment' }]);

      await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      // First query is the tenant-scoped user check, bound (never interpolated)
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FROM "auth"."users" WHERE id = $1 AND "tenantId" = $2'),
        [USER_ID, TENANT_ID],
      );
    });

    it('should re-point the single existing row when the user already holds a role', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }]) // target role
        .mockResolvedValueOnce([{ id: 'existing-assignment', is_active: false, role_id: 'old-role' }]) // existing row (in-tenant)
        .mockResolvedValueOnce([]); // UPDATE re-point

      const result = await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.id).toBe('existing-assignment');
      expect(result.isActive).toBe(true);
      // The 4th query is the re-point UPDATE — never a 2nd INSERT
      const updateCall = mockQueryRunner.query.mock.calls[3]!;
      expect(updateCall[0]).toContain('UPDATE "auth"."user_role_assignments" ura');
      expect(updateCall[0]).toContain('role_id = $4');
      expect(updateCall[0]).toContain('is_active = true');
      expect(updateCall[1]).toEqual([ADMIN_USER_ID, 'existing-assignment', TENANT_ID, ROLE_ID]);
    });

    it('should throw NotFoundException when role does not exist in tenant', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([]); // role not found

      await expect(
        service.assignRoleToUser(TENANT_ID, USER_ID, 'bad-role-id', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should lock the in-tenant role with FOR UPDATE to prevent deletion during assignment', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'new-assignment' }]);

      await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      // Second query (after user check) locks the role, scoped to tenant
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('WHERE id = $1 AND "tenantId" = $2 FOR UPDATE'),
        [ROLE_ID, TENANT_ID],
      );
    });

    it('should rollback transaction on error', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }])
        .mockResolvedValueOnce([]) // no existing assignment
        .mockRejectedValueOnce(new Error('constraint violation'));

      await expect(
        service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow('constraint violation');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // REGRESSION (ORPHAN-CRITICAL-100, FINDING #1): foreign-tenant user
    // ------------------------------------------------------------------------
    it('REGRESSION: foreign-tenant user throws and performs ZERO inserts/updates', async () => {
      // User pre-validation returns no row => user not in this tenant.
      mockQueryRunner.query.mockResolvedValueOnce([]);

      await expect(
        service.assignRoleToUser(TENANT_ID, 'foreign-tenant-user', ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);

      // Only the user-validation SELECT ran; no role lock, no assignment write.
      expect(mockQueryRunner.query).toHaveBeenCalledTimes(1);
      const writeCall = mockQueryRunner.query.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          (c[0].includes('INSERT INTO "auth"."user_role_assignments"') ||
            c[0].includes('UPDATE "auth"."user_role_assignments"')),
      );
      expect(writeCall).toBeUndefined();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // REGRESSION (ORPHAN-CRITICAL-100, FINDING #2): UNIQUE(user_id) re-point
    // ------------------------------------------------------------------------
    it('REGRESSION: assigning a 2nd role re-points the single row (no UNIQUE violation, no 2nd INSERT)', async () => {
      const SECOND_ROLE_ID = 'role-uuid-002';
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: SECOND_ROLE_ID, name: 'Supervisor', is_system: false }]) // 2nd target role
        .mockResolvedValueOnce([{ id: 'existing-assignment', is_active: true, role_id: ROLE_ID }]) // user already holds ROLE_ID
        .mockResolvedValueOnce([]); // UPDATE re-point to SECOND_ROLE_ID

      const result = await service.assignRoleToUser(
        TENANT_ID,
        USER_ID,
        SECOND_ROLE_ID,
        ADMIN_USER_ID,
      );

      // Same single row, re-pointed — no constraint error.
      expect(result.id).toBe('existing-assignment');
      expect(result.roleId).toBe(SECOND_ROLE_ID);

      // No INSERT into user_role_assignments was attempted.
      const insertCall = mockQueryRunner.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO "auth"."user_role_assignments"'),
      );
      expect(insertCall).toBeUndefined();

      // The re-point UPDATE sets the new role_id ($4 = SECOND_ROLE_ID).
      const updateCall = mockQueryRunner.query.mock.calls[3]!;
      expect(updateCall[0]).toContain('SET is_active = true, role_id = $4');
      expect(updateCall[1]).toEqual([ADMIN_USER_ID, 'existing-assignment', TENANT_ID, SECOND_ROLE_ID]);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // removeRoleFromUser
  // ==========================================================================

  describe('removeRoleFromUser', () => {
    it('should soft-delete (deactivate) a role assignment using only GROUND-TRUTH columns', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([{ id: 'assignment-1', is_active: true }]) // lock + fetch (in-tenant)
        .mockResolvedValueOnce([]); // UPDATE is_active = false

      const result = await service.removeRoleFromUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result).toBe(true);
      const updateCall = mockQueryRunner.query.mock.calls[2]!;
      // GROUND TRUTH: auth.user_role_assignments has no removed_by/removed_at/updated_by.
      // Soft-delete sets only is_active and updated_at.
      expect(updateCall[0]).toContain('is_active = false');
      expect(updateCall[0]).toContain('updated_at = NOW()');
      // Banned (non-existent) columns must NOT be written — would fail at runtime.
      expect(updateCall[0]).not.toContain('removed_by');
      expect(updateCall[0]).not.toContain('removed_at');
      expect(updateCall[0]).not.toContain('updated_by');
      // Param indices re-counted after dropping the removed_by bind: ura.id=$1, tenantId=$2.
      expect(updateCall[0]).toContain('WHERE ura.id = $1 AND tr.id = ura.role_id AND tr."tenantId" = $2');
      // The actor (removedBy) is NOT persisted on this table — params carry only id + tenantId.
      expect(updateCall[1]).toEqual(['assignment-1', TENANT_ID]);
    });

    it('should throw NotFoundException when no active assignment exists', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // user in tenant
        .mockResolvedValueOnce([]); // no active assignment

      await expect(
        service.removeRoleFromUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when the user is not in the tenant', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]); // user not in tenant

      await expect(
        service.removeRoleFromUser(TENANT_ID, 'foreign-user', ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);

      // No assignment write attempted.
      expect(mockQueryRunner.query).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // setDefaultRole
  // ==========================================================================

  describe('setDefaultRole', () => {
    it('should set a role as default and unset others within the tenant', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator' }]) // role exists in tenant
        .mockResolvedValueOnce([]) // unset other defaults
        .mockResolvedValueOnce([]); // set new default

      // getRoleById after commit
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ is_default: true }),
      ]);

      const result = await service.setDefaultRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.isDefault).toBe(true);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      // Lock target is tenant-scoped
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WHERE id = $1 AND "tenantId" = $2 FOR UPDATE'),
        [ROLE_ID, TENANT_ID],
      );
      // Unset others is scoped to tenant
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('WHERE is_default = true AND id != $1 AND "tenantId" = $2'),
        [ROLE_ID, TENANT_ID],
      );
      // Set new default is scoped to tenant
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('WHERE id = $1 AND "tenantId" = $2'),
        [ROLE_ID, TENANT_ID],
      );
    });

    it('should throw NotFoundException for non-existent role', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]); // role not found

      await expect(
        service.setDefaultRole(TENANT_ID, 'bad-id', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // getPermissionCategories
  // ==========================================================================

  describe('getPermissionCategories', () => {
    it('should return all permission categories', () => {
      const categories = service.getPermissionCategories();

      expect(categories).toBeDefined();
      expect(categories.farm).toBeDefined();
      expect(categories.farm.name).toBe('Farm Management');
      expect(categories.batch).toBeDefined();
      expect(categories.operations).toBeDefined();
      expect(categories.hr).toBeDefined();
      expect(categories.reports).toBeDefined();
      expect(categories.admin).toBeDefined();
    });
  });

  // ==========================================================================
  // Tenant Isolation (auth.* + bound tenantId)
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should always bind tenantId as a parameter (never interpolated) for read queries', async () => {
      const tenantIdA = '22222222-2222-2222-2222-222222222222';
      mockDataSource.query.mockResolvedValue([]);

      await service.getTenantRoles(tenantIdA);

      const [sql, params] = mockDataSource.query.mock.calls[0]!;
      // Schema/table literal — tenant comes through a bound param, not the SQL text.
      expect(sql).toContain('"auth"."tenant_roles"');
      expect(sql).not.toContain(tenantIdA);
      expect(params).toEqual([tenantIdA]);
    });

    it('REGRESSION: createRole unset-default write leaves OTHER tenants intact (tenantId predicate present)', async () => {
      const tenantIdB = '33333333-3333-3333-3333-333333333333';
      const defaultInput = {
        name: 'Cross-Tenant Default',
        isDefault: true,
        panelPermissions: {},
      };

      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([]) // UPDATE unset defaults
        .mockResolvedValueOnce([{ id: 'new-id' }]) // INSERT
        .mockResolvedValueOnce([]); // permissions

      mockDataSource.query.mockResolvedValue([createMockRoleRow({ is_default: true })]);

      await service.createRole(tenantIdB, defaultInput, ADMIN_USER_ID);

      // The unset-default UPDATE MUST carry the tenant guard, scoped to tenantIdB.
      const unsetCall = mockQueryRunner.query.mock.calls[1]!;
      expect(unsetCall[0]).toContain('SET is_default = false');
      expect(unsetCall[0]).toContain('WHERE is_default = true AND "tenantId" = $1');
      expect(unsetCall[1]).toEqual([tenantIdB]);
    });

    it('REGRESSION: updateRole unset-other-defaults write is tenant-scoped', async () => {
      const tenantIdC = '44444444-4444-4444-4444-444444444444';
      mockQueryRunner.query
        .mockResolvedValueOnce([createMockRoleRow({ is_default: false })]) // existing (not default)
        .mockResolvedValueOnce([]) // unset other defaults
        .mockResolvedValueOnce([]); // UPDATE role

      mockDataSource.query.mockResolvedValue([createMockRoleRow({ is_default: true })]);

      await service.updateRole(tenantIdC, ROLE_ID, { isDefault: true }, ADMIN_USER_ID);

      const unsetCall = mockQueryRunner.query.mock.calls[1]!;
      expect(unsetCall[0]).toContain('WHERE is_default = true AND id != $1 AND "tenantId" = $2');
      expect(unsetCall[1]).toEqual([ROLE_ID, tenantIdC]);
    });

    it('REGRESSION: setDefaultRole unset-current-defaults write is tenant-scoped', async () => {
      const tenantIdD = '55555555-5555-5555-5555-555555555555';
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator' }]) // role exists
        .mockResolvedValueOnce([]) // unset other defaults
        .mockResolvedValueOnce([]); // set new default

      mockDataSource.query.mockResolvedValue([createMockRoleRow({ is_default: true })]);

      await service.setDefaultRole(tenantIdD, ROLE_ID, ADMIN_USER_ID);

      const unsetCall = mockQueryRunner.query.mock.calls[1]!;
      expect(unsetCall[0]).toContain('WHERE is_default = true AND id != $1 AND "tenantId" = $2');
      expect(unsetCall[1]).toEqual([ROLE_ID, tenantIdD]);
    });
  });

  // ==========================================================================
  // Transaction Safety
  // ==========================================================================

  describe('Transaction Safety', () => {
    it('should always release queryRunner in createRole even on commit failure', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-id' }]) // INSERT role
        .mockResolvedValueOnce([]); // INSERT permissions

      mockQueryRunner.commitTransaction.mockRejectedValueOnce(new Error('commit failed'));

      await expect(
        service.createRole(
          TENANT_ID,
          { name: 'Fail', panelPermissions: {} },
          ADMIN_USER_ID,
        ),
      ).rejects.toThrow('commit failed');

      expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('should always release queryRunner in deleteRole even on commit failure', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        { id: ROLE_ID, name: 'Custom', is_system: false, user_count: 0 },
      ]);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.commitTransaction.mockRejectedValueOnce(new Error('commit failed'));

      await expect(
        service.deleteRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow('commit failed');

      expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});
