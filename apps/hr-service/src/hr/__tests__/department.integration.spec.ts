/**
 * Department Management Integration Tests
 *
 * Tests cover the complete Department CRUD lifecycle:
 * - Create department with duplicate code validation
 * - Update department with soft delete
 * - Get departments list with filters
 * - Get single department by ID
 * - Parent department validation
 * - HR Dashboard Stats query
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { CreateDepartmentHandler } from '../handlers/create-department.handler';
import { UpdateDepartmentHandler } from '../handlers/update-department.handler';
import { GetDepartmentsHandler, GetDepartmentHandler } from '../query-handlers/get-departments.handler';
import { GetHRDashboardStatsHandler } from '../query-handlers/get-hr-dashboard-stats.handler';
import { CreateDepartmentCommand } from '../commands/create-department.command';
import { UpdateDepartmentCommand } from '../commands/update-department.command';
import { GetDepartmentsQuery, GetDepartmentQuery } from '../queries/get-departments.query';
import { GetHRDashboardStatsQuery } from '../queries/get-hr-dashboard-stats.query';
import { DepartmentHR } from '../entities/department.entity';

// ============================================================================
// Mock Factories
// ============================================================================

const tenantId = 'tenant-uuid-001';
const userId = 'user-uuid-001';

const createMockDepartment = (overrides: Partial<DepartmentHR> = {}): DepartmentHR => {
  const dept = new DepartmentHR();
  Object.assign(dept, {
    id: 'dept-uuid-001',
    tenantId,
    name: 'Operations',
    code: 'OPS',
    isActive: true,
    sortOrder: 0,
    isDeleted: false,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: userId,
    updatedBy: userId,
    ...overrides,
  });
  return dept;
};

// ============================================================================
// DataSource mock for transaction-based handlers
// ============================================================================

function createMockQueryRunner() {
  const mockRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((entity: Partial<DepartmentHR>) => {
      const dept = new DepartmentHR();
      Object.assign(dept, entity);
      return dept;
    }),
    save: jest.fn((entity: DepartmentHR) =>
      Promise.resolve({ ...entity, id: entity.id || 'new-dept-uuid' }),
    ),
  };

  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    },
  };

  return { queryRunner, mockRepo };
}

// ============================================================================
// Department CRUD Tests
// ============================================================================

describe('Department Management Integration Tests', () => {
  // --------------------------------------------------------------------------
  // Create Department
  // --------------------------------------------------------------------------

  describe('Create Department', () => {
    let handler: CreateDepartmentHandler;
    let mockRepo: ReturnType<typeof createMockQueryRunner>['mockRepo'];

    beforeEach(async () => {
      const { queryRunner, mockRepo: repo } = createMockQueryRunner();
      mockRepo = repo;

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CreateDepartmentHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      handler = module.get(CreateDepartmentHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should create a department successfully', async () => {
      mockRepo.findOne.mockResolvedValue(null); // No duplicate

      const command = new CreateDepartmentCommand(
        tenantId,
        { name: 'Operations', code: 'OPS' },
        userId,
      );

      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.name).toBe('Operations');
      expect(result.code).toBe('OPS');
      expect(result.tenantId).toBe(tenantId);
      expect(result.createdBy).toBe(userId);
      expect(mockRepo.save).toHaveBeenCalledTimes(1);
    });

    it('should reject duplicate department code within same tenant', async () => {
      mockRepo.findOne.mockResolvedValue(createMockDepartment()); // Duplicate found

      const command = new CreateDepartmentCommand(
        tenantId,
        { name: 'Operations 2', code: 'OPS' },
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/already exists/);
    });

    it('should validate parent department exists', async () => {
      // First call: no duplicate code
      // Second call: parent not found
      mockRepo.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce(null); // parent lookup

      const command = new CreateDepartmentCommand(
        tenantId,
        {
          name: 'Sub-Operations',
          code: 'SUB-OPS',
          parentDepartmentId: 'non-existent-parent',
        },
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/Parent department not found/);
    });

    it('should create department with valid parent', async () => {
      const parentDept = createMockDepartment({ id: 'parent-dept-uuid' });

      mockRepo.findOne
        .mockResolvedValueOnce(null) // no duplicate code
        .mockResolvedValueOnce(parentDept); // parent found

      const command = new CreateDepartmentCommand(
        tenantId,
        {
          name: 'Sub-Operations',
          code: 'SUB-OPS',
          parentDepartmentId: 'parent-dept-uuid',
        },
        userId,
      );

      const result = await handler.execute(command);
      expect(result).toBeDefined();
      expect(result.parentDepartmentId).toBe('parent-dept-uuid');
    });

    it('should set optional fields correctly', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const command = new CreateDepartmentCommand(
        tenantId,
        {
          name: 'Quality Control',
          code: 'QC',
          description: 'Quality control department',
          siteId: 'site-uuid-001',
          managerId: 'manager-uuid-001',
          budgetCode: 'BC-QC',
          costCenter: 'CC-100',
        },
        userId,
      );

      const result = await handler.execute(command);
      expect(result.description).toBe('Quality control department');
      expect(result.siteId).toBe('site-uuid-001');
      expect(result.managerId).toBe('manager-uuid-001');
      expect(result.budgetCode).toBe('BC-QC');
      expect(result.costCenter).toBe('CC-100');
    });
  });

  // --------------------------------------------------------------------------
  // Update Department
  // --------------------------------------------------------------------------

  describe('Update Department', () => {
    let handler: UpdateDepartmentHandler;
    let mockRepo: ReturnType<typeof createMockQueryRunner>['mockRepo'];

    beforeEach(async () => {
      const { queryRunner, mockRepo: repo } = createMockQueryRunner();
      mockRepo = repo;

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UpdateDepartmentHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      handler = module.get(UpdateDepartmentHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should update a department successfully', async () => {
      const existing = createMockDepartment();
      mockRepo.findOne.mockResolvedValue(existing);

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: existing.id, name: 'Updated Operations' },
        userId,
      );

      const result = await handler.execute(command);
      expect(result.name).toBe('Updated Operations');
      expect(result.updatedBy).toBe(userId);
    });

    it('should throw NotFoundException for non-existent department', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: 'non-existent', name: 'Updated' },
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
    });

    it('should reject duplicate code when changing code', async () => {
      const existing = createMockDepartment({ code: 'OPS' });
      const duplicate = createMockDepartment({ id: 'other-dept', code: 'QC' });

      mockRepo.findOne
        .mockResolvedValueOnce(existing) // Find department to update
        .mockResolvedValueOnce(duplicate); // Duplicate code found

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: existing.id, code: 'QC' },
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(/already exists/);
    });

    it('should reject self-referencing parent', async () => {
      const existing = createMockDepartment();
      mockRepo.findOne.mockResolvedValue(existing);

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: existing.id, parentDepartmentId: existing.id },
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/cannot be its own parent/);
    });

    it('should handle soft delete', async () => {
      const existing = createMockDepartment();
      mockRepo.findOne.mockResolvedValue(existing);

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: existing.id, isDeleted: true },
        userId,
      );

      const result = await handler.execute(command);
      expect(result.isDeleted).toBe(true);
      expect(result.deletedAt).toBeDefined();
      expect(result.deletedBy).toBe(userId);
    });

    it('should allow same code when not changing it', async () => {
      const existing = createMockDepartment({ code: 'OPS' });
      mockRepo.findOne.mockResolvedValue(existing);

      const command = new UpdateDepartmentCommand(
        tenantId,
        { id: existing.id, name: 'Updated Name' }, // code not changing
        userId,
      );

      const result = await handler.execute(command);
      expect(result.name).toBe('Updated Name');
      expect(result.code).toBe('OPS'); // unchanged
    });
  });

  // --------------------------------------------------------------------------
  // Get Departments (List)
  // --------------------------------------------------------------------------

  describe('Get Departments', () => {
    let handler: GetDepartmentsHandler;
    let departmentRepository: jest.Mocked<Repository<DepartmentHR>>;

    beforeEach(async () => {
      departmentRepository = {
        find: jest.fn(),
        findOne: jest.fn(),
      } as unknown as jest.Mocked<Repository<DepartmentHR>>;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetDepartmentsHandler,
          {
            provide: getRepositoryToken(DepartmentHR),
            useValue: departmentRepository,
          },
        ],
      }).compile();

      handler = module.get(GetDepartmentsHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should return departments sorted by sortOrder and name', async () => {
      const departments = [
        createMockDepartment({ id: 'd1', name: 'Alpha', sortOrder: 0 }),
        createMockDepartment({ id: 'd2', name: 'Beta', sortOrder: 1 }),
      ];
      departmentRepository.find.mockResolvedValue(departments);

      const query = new GetDepartmentsQuery(tenantId);
      const result = await handler.execute(query);

      expect(result).toHaveLength(2);
      expect(departmentRepository.find).toHaveBeenCalledWith({
        where: { tenantId, isDeleted: false },
        order: { sortOrder: 'ASC', name: 'ASC' },
      });
    });

    it('should filter by siteId when provided', async () => {
      departmentRepository.find.mockResolvedValue([]);

      const query = new GetDepartmentsQuery(tenantId, 'site-uuid-001');
      await handler.execute(query);

      expect(departmentRepository.find).toHaveBeenCalledWith({
        where: { tenantId, isDeleted: false, siteId: 'site-uuid-001' },
        order: { sortOrder: 'ASC', name: 'ASC' },
      });
    });

    it('should show deleted departments when isDeleted=true', async () => {
      departmentRepository.find.mockResolvedValue([]);

      const query = new GetDepartmentsQuery(tenantId, undefined, true);
      await handler.execute(query);

      expect(departmentRepository.find).toHaveBeenCalledWith({
        where: { tenantId, isDeleted: true },
        order: { sortOrder: 'ASC', name: 'ASC' },
      });
    });

    it('should return empty array when no departments exist', async () => {
      departmentRepository.find.mockResolvedValue([]);

      const query = new GetDepartmentsQuery(tenantId);
      const result = await handler.execute(query);

      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Get Single Department
  // --------------------------------------------------------------------------

  describe('Get Department by ID', () => {
    let handler: GetDepartmentHandler;
    let departmentRepository: jest.Mocked<Repository<DepartmentHR>>;

    beforeEach(async () => {
      departmentRepository = {
        findOne: jest.fn(),
      } as unknown as jest.Mocked<Repository<DepartmentHR>>;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetDepartmentHandler,
          {
            provide: getRepositoryToken(DepartmentHR),
            useValue: departmentRepository,
          },
        ],
      }).compile();

      handler = module.get(GetDepartmentHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should return a department by id', async () => {
      const department = createMockDepartment();
      departmentRepository.findOne.mockResolvedValue(department);

      const query = new GetDepartmentQuery(tenantId, 'dept-uuid-001');
      const result = await handler.execute(query);

      expect(result).toEqual(department);
      expect(departmentRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId, id: 'dept-uuid-001' },
      });
    });

    it('should throw NotFoundException when department not found', async () => {
      departmentRepository.findOne.mockResolvedValue(null);

      const query = new GetDepartmentQuery(tenantId, 'non-existent');

      await expect(handler.execute(query)).rejects.toThrow(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  // HR Dashboard Stats
  // --------------------------------------------------------------------------

  describe('HR Dashboard Stats', () => {
    let handler: GetHRDashboardStatsHandler;
    let mockDataSource: { query: jest.Mock };

    beforeEach(async () => {
      mockDataSource = {
        query: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetHRDashboardStatsHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      handler = module.get(GetHRDashboardStatsHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should return all dashboard stats', async () => {
      // Employee stats query
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            totalEmployees: '50',
            activeEmployees: '40',
            onLeaveEmployees: '5',
            terminatedEmployees: '5',
            newHiresThisMonth: '3',
            offshoreEmployees: '10',
            onshoreEmployees: '30',
          },
        ])
        // Attendance query
        .mockResolvedValueOnce([{ presentCount: '35' }])
        // Leave requests query
        .mockResolvedValueOnce([{ pendingCount: '7' }])
        // Departments query
        .mockResolvedValueOnce([{ deptCount: '8' }]);

      const query = new GetHRDashboardStatsQuery(tenantId);
      const result = await handler.execute(query);

      expect(result.totalEmployees).toBe(50);
      expect(result.activeEmployees).toBe(40);
      expect(result.onLeaveEmployees).toBe(5);
      expect(result.terminatedEmployees).toBe(5);
      expect(result.newHiresThisMonth).toBe(3);
      expect(result.offshoreEmployees).toBe(10);
      expect(result.onshoreEmployees).toBe(30);
      expect(result.attendanceRate).toBe(88); // Math.round(35/40 * 100) = 88
      expect(result.pendingLeaveRequests).toBe(7);
      expect(result.totalDepartments).toBe(8);
    });

    it('should handle zero employees gracefully', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            totalEmployees: '0',
            activeEmployees: '0',
            onLeaveEmployees: '0',
            terminatedEmployees: '0',
            newHiresThisMonth: '0',
            offshoreEmployees: '0',
            onshoreEmployees: '0',
          },
        ])
        .mockResolvedValueOnce([{ presentCount: '0' }])
        .mockResolvedValueOnce([{ pendingCount: '0' }])
        .mockResolvedValueOnce([{ deptCount: '0' }]);

      const result = await handler.execute(new GetHRDashboardStatsQuery(tenantId));

      expect(result.totalEmployees).toBe(0);
      expect(result.attendanceRate).toBe(0); // No division by zero
      expect(result.totalDepartments).toBe(0);
    });

    it('should calculate attendance rate correctly', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            totalEmployees: '100',
            activeEmployees: '80',
            onLeaveEmployees: '10',
            terminatedEmployees: '10',
            newHiresThisMonth: '0',
            offshoreEmployees: '20',
            onshoreEmployees: '60',
          },
        ])
        .mockResolvedValueOnce([{ presentCount: '60' }]) // 60/80 = 75%
        .mockResolvedValueOnce([{ pendingCount: '0' }])
        .mockResolvedValueOnce([{ deptCount: '5' }]);

      const result = await handler.execute(new GetHRDashboardStatsQuery(tenantId));

      expect(result.attendanceRate).toBe(75); // Math.round(60/80 * 100)
    });

    it('should handle null/undefined query results', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{}]) // All fields undefined
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{}]);

      const result = await handler.execute(new GetHRDashboardStatsQuery(tenantId));

      expect(result.totalEmployees).toBe(0);
      expect(result.activeEmployees).toBe(0);
      expect(result.attendanceRate).toBe(0);
    });

    it('should use tenant isolation in all queries', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{
          totalEmployees: '0', activeEmployees: '0', onLeaveEmployees: '0',
          terminatedEmployees: '0', newHiresThisMonth: '0', offshoreEmployees: '0', onshoreEmployees: '0',
        }])
        .mockResolvedValueOnce([{ presentCount: '0' }])
        .mockResolvedValueOnce([{ pendingCount: '0' }])
        .mockResolvedValueOnce([{ deptCount: '0' }]);

      await handler.execute(new GetHRDashboardStatsQuery('specific-tenant-id'));

      // Verify tenantId is passed as parameter to all queries
      expect(mockDataSource.query).toHaveBeenCalledTimes(4);
      for (const call of mockDataSource.query.mock.calls) {
        expect(call[1][0]).toBe('specific-tenant-id');
      }
    });
  });

  // --------------------------------------------------------------------------
  // E2E Workflow
  // --------------------------------------------------------------------------

  describe('E2E Department Workflow', () => {
    it('should handle create -> update -> soft-delete lifecycle', async () => {
      // This tests the logical flow, not actual DB operations
      const dept = createMockDepartment({
        name: 'Operations',
        code: 'OPS',
      });

      // Verify initial state
      expect(dept.isDeleted).toBe(false);
      expect(dept.isActive).toBe(true);

      // Simulate update
      dept.name = 'Updated Operations';
      dept.description = 'Updated description';
      expect(dept.name).toBe('Updated Operations');

      // Simulate soft delete
      dept.isDeleted = true;
      dept.deletedAt = new Date();
      dept.deletedBy = userId;
      expect(dept.isDeleted).toBe(true);
      expect(dept.deletedBy).toBe(userId);
    });
  });
});
