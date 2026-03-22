/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryRunner } from 'typeorm';
import { SchemaManagerService } from '@aquaculture/backend-common';

import { TenantRoleService } from '../services/tenant-role.service';

// ============================================================================
// Constants
// ============================================================================

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_SCHEMA = `tenant_${TENANT_ID.replace(/-/g, '_')}`;
const ROLE_ID = 'role-uuid-001';
const USER_ID = 'user-uuid-001';
const ADMIN_USER_ID = 'admin-uuid-001';

// ============================================================================
// Mock QueryRunner Factory
// ============================================================================

const createMockQueryRunner = (): jest.Mocked<
  Pick<QueryRunner, 'connect' | 'startTransaction' | 'commitTransaction' | 'rollbackTransaction' | 'release' | 'query'>
> => ({
  connect: jest.fn().mockResolvedValue(undefined),
  startTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue([]),
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
  let mockSchemaManager: jest.Mocked<Pick<SchemaManagerService, 'getTenantSchemaName' | 'tableExists'>>;
  let mockQueryRunner: ReturnType<typeof createMockQueryRunner>;

  beforeEach(async () => {
    mockQueryRunner = createMockQueryRunner();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    mockSchemaManager = {
      getTenantSchemaName: jest.fn().mockReturnValue(TENANT_SCHEMA),
      tableExists: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantRoleService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: SchemaManagerService, useValue: mockSchemaManager },
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
      expect(mockSchemaManager.getTenantSchemaName).toHaveBeenCalledWith(TENANT_ID);
    });

    it('should return empty array when tenant_roles table does not exist', async () => {
      mockSchemaManager.tableExists.mockResolvedValue(false);

      const result = await service.getTenantRoles(TENANT_ID);

      expect(result).toEqual([]);
      expect(mockDataSource.query).not.toHaveBeenCalled();
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
  });

  // ==========================================================================
  // getRoleById
  // ==========================================================================

  describe('getRoleById', () => {
    it('should return a role by ID', async () => {
      mockDataSource.query.mockResolvedValue([createMockRoleRow()]);

      const result = await service.getRoleById(TENANT_ID, ROLE_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(ROLE_ID);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE r.id = $1'),
        [ROLE_ID],
      );
    });

    it('should return null when role does not exist', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.getRoleById(TENANT_ID, 'non-existent-id');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // getDefaultRole
  // ==========================================================================

  describe('getDefaultRole', () => {
    it('should return the default role', async () => {
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ is_default: true, name: 'Operator' }),
      ]);

      const result = await service.getDefaultRole(TENANT_ID);

      expect(result).not.toBeNull();
      expect(result!.isDefault).toBe(true);
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

    it('should throw ConflictException for duplicate role name', async () => {
      // Duplicate check returns existing
      mockQueryRunner.query.mockResolvedValueOnce([{ id: 'existing-id' }]);

      await expect(
        service.createRole(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should use case-insensitive duplicate check with FOR UPDATE', async () => {
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
        expect.stringContaining('LOWER(name) = LOWER($1)'),
        [createInput.name],
      );
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FOR UPDATE'),
        expect.any(Array),
      );
    });

    it('should unset other defaults when creating a default role', async () => {
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

      // Second query should be the UPDATE to unset defaults
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('SET is_default = false'),
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

      // The INSERT query should use default values
      const insertCall = mockQueryRunner.query.mock.calls[1];
      const insertParams = insertCall![1];
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

    it('should update permissions when panelPermissions provided', async () => {
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

      // Verify that one of the queryRunner calls updates tenant_role_permissions
      const permUpdateCall = mockQueryRunner.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('tenant_role_permissions'),
      );
      expect(permUpdateCall).toBeDefined();
      // The SQL should be an UPDATE on tenant_role_permissions
      expect(permUpdateCall![0]).toContain('UPDATE');
      expect(permUpdateCall![0]).toContain('panel_permissions');
      expect(permUpdateCall![0]).toContain('resource_permissions');
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
        (c) => typeof c[0] === 'string' && c[0].includes('DELETE') && c[0].includes('tenant_roles'),
      );
      expect(permDeleteIndex).toBeLessThan(roleDeleteIndex);
    });
  });

  // ==========================================================================
  // assignRoleToUser
  // ==========================================================================

  describe('assignRoleToUser', () => {
    it('should create a new role assignment', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: true }]) // role exists
        .mockResolvedValueOnce([]) // no existing assignment
        .mockResolvedValueOnce([{ id: 'assignment-001' }]); // INSERT assignment

      const result = await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.userId).toBe(USER_ID);
      expect(result.roleId).toBe(ROLE_ID);
      expect(result.isActive).toBe(true);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should reactivate an inactive assignment instead of creating a new one', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: true }]) // role exists
        .mockResolvedValueOnce([{ id: 'existing-assignment', is_active: false }]) // inactive assignment
        .mockResolvedValueOnce([]); // UPDATE reactivate

      const result = await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.id).toBe('existing-assignment');
      expect(result.isActive).toBe(true);
      // Should call UPDATE, not INSERT
      const updateCall = mockQueryRunner.query.mock.calls[2]!;
      expect(updateCall[0]).toContain('UPDATE');
      expect(updateCall[0]).toContain('is_active = true');
    });

    it('should not modify an already active assignment', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: true }]) // role exists
        .mockResolvedValueOnce([{ id: 'existing-active', is_active: true }]); // already active

      const result = await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.id).toBe('existing-active');
      // Should NOT have called a third query (no UPDATE or INSERT)
      expect(mockQueryRunner.query).toHaveBeenCalledTimes(2);
    });

    it('should throw NotFoundException when role does not exist', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]); // role not found

      await expect(
        service.assignRoleToUser(TENANT_ID, USER_ID, 'bad-role-id', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should use FOR UPDATE to lock role and prevent deletion during assignment', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'new-assignment' }]);

      await service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      // First query should contain FOR UPDATE
      expect(mockQueryRunner.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FOR UPDATE'),
        [ROLE_ID],
      );
    });

    it('should rollback transaction on error', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator', is_system: false }])
        .mockResolvedValueOnce([]) // no existing assignment
        .mockRejectedValueOnce(new Error('constraint violation'));

      await expect(
        service.assignRoleToUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow('constraint violation');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // removeRoleFromUser
  // ==========================================================================

  describe('removeRoleFromUser', () => {
    it('should soft-delete (deactivate) a role assignment', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: 'assignment-1', is_active: true }]) // lock + fetch
        .mockResolvedValueOnce([]); // UPDATE is_active = false

      const result = await service.removeRoleFromUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result).toBe(true);
      const updateCall = mockQueryRunner.query.mock.calls[1]!;
      expect(updateCall[0]).toContain('is_active = false');
    });

    it('should throw NotFoundException when no active assignment exists', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([]); // no active assignment

      await expect(
        service.removeRoleFromUser(TENANT_ID, USER_ID, ROLE_ID, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // setDefaultRole
  // ==========================================================================

  describe('setDefaultRole', () => {
    it('should set a role as default and unset others', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ id: ROLE_ID, name: 'Operator' }]) // role exists
        .mockResolvedValueOnce([]) // unset other defaults
        .mockResolvedValueOnce([]); // set new default

      // getRoleById after commit
      mockDataSource.query.mockResolvedValue([
        createMockRoleRow({ is_default: true }),
      ]);

      const result = await service.setDefaultRole(TENANT_ID, ROLE_ID, ADMIN_USER_ID);

      expect(result.isDefault).toBe(true);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
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
  // Tenant Isolation
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should always use the correct tenant schema name for queries', async () => {
      const tenantIdA = '22222222-2222-2222-2222-222222222222';
      const schemaA = 'tenant_22222222_2222_2222_2222_222222222222';

      mockSchemaManager.getTenantSchemaName.mockReturnValue(schemaA);
      mockDataSource.query.mockResolvedValue([]);

      await service.getTenantRoles(tenantIdA);

      expect(mockSchemaManager.getTenantSchemaName).toHaveBeenCalledWith(tenantIdA);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(schemaA),
      );
    });

    it('should use tenant-specific schema in createRole transaction queries', async () => {
      const tenantIdB = '33333333-3333-3333-3333-333333333333';
      const schemaB = 'tenant_33333333_3333_3333_3333_333333333333';
      mockSchemaManager.getTenantSchemaName.mockReturnValue(schemaB);

      mockQueryRunner.query
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([{ id: 'new-id' }]) // INSERT
        .mockResolvedValueOnce([]); // permissions

      mockDataSource.query.mockResolvedValue([createMockRoleRow()]);

      await service.createRole(
        tenantIdB,
        { name: 'Cross-Tenant Test', panelPermissions: {} },
        ADMIN_USER_ID,
      );

      // All queryRunner calls should reference the correct schema
      mockQueryRunner.query.mock.calls.forEach(([sql]) => {
        if (typeof sql === 'string' && sql.includes('tenant_')) {
          expect(sql).toContain(schemaB);
        }
      });
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
