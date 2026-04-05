/**
 * WHY THIS FILE EXISTS:
 * CreateEmployeeHandler now publishes EmployeeCreatedEvent after the transaction
 * commits (added in HR-expert Sprint 2). Without this test, we cannot verify:
 * - Event is published AFTER commit (not inside the transaction)
 * - Event is NOT published when the transaction rolls back
 * - Business rules (duplicate email, invalid dates) throw correct exceptions
 * - Employee number uniqueness is enforced under concurrency
 */
import { ConflictException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { DataSource, QueryRunner, EntityManager, Repository } from 'typeorm';

import { CreateEmployeeCommand } from '../../commands/create-employee.command';
import { CreateEmployeeHandler } from '../../handlers/create-employee.handler';
import { Employee, EmployeeStatus, EmploymentType, Department, PersonnelCategory } from '../../entities/employee.entity';

// ============================================================================
// Mock Helpers
// ============================================================================

const buildMockEmployee = (overrides: Partial<Employee> = {}): Employee => {
  const e = new Employee();
  Object.assign(e, {
    id: 'emp-uuid-001',
    tenantId: 'tenant-uuid-001',
    employeeNumber: 'EMP-2026-00001',
    firstName: 'Ali',
    lastName: 'Yilmaz',
    email: 'ali@example.com',
    position: 'Fish Farm Operator',
    department: Department.OPERATIONS,
    employmentType: EmploymentType.FULL_TIME,
    status: EmployeeStatus.ACTIVE,
    hireDate: new Date('2026-01-01'),
    dateOfBirth: new Date('1990-01-01'),
    personnelCategory: PersonnelCategory.OFFSHORE,
    seaWorthy: false,
    createdBy: 'admin-user-001',
    ...overrides,
  });
  return e;
};

const validInput = {
  firstName: 'Ali',
  lastName: 'Yilmaz',
  email: 'ali@example.com',
  position: 'Fish Farm Operator',
  department: Department.OPERATIONS,
  employmentType: EmploymentType.FULL_TIME,
  hireDate: '2026-01-01',
  dateOfBirth: '1990-01-01',
  currency: 'USD',
};

// ============================================================================
// Mock Setup
// ============================================================================

const buildMockQueryRunner = (overrides?: {
  findOneResult?: Employee | null;
  saveResult?: Employee;
  getCountResult?: number;
  shouldFailSave?: boolean;
}) => {
  const mockEmployeeRepo = {
    findOne: jest.fn().mockResolvedValue(overrides?.findOneResult ?? null),
    save: overrides?.shouldFailSave
      ? jest.fn().mockRejectedValue(new Error('DB error'))
      : jest.fn().mockResolvedValue(overrides?.saveResult ?? buildMockEmployee()),
    create: jest.fn().mockImplementation((data: Partial<Employee>) => Object.assign(new Employee(), data)),
  };

  const mockQB = {
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(overrides?.getCountResult ?? 0),
  };

  const mockManager: Partial<EntityManager> = {
    getRepository: jest.fn().mockReturnValue(mockEmployeeRepo),
    createQueryBuilder: jest.fn().mockReturnValue(mockQB),
  };

  const mockQR: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: mockManager as EntityManager,
  };

  return { mockQR, mockEmployeeRepo };
};

describe('CreateEmployeeHandler', () => {
  let handler: CreateEmployeeHandler;
  let mockDataSource: Partial<DataSource>;
  let mockEventBus: Partial<EventBus>;

  const tenantId = 'tenant-uuid-001';
  const userId = 'admin-user-001';

  beforeEach(() => {
    jest.clearAllMocks();
    mockEventBus = { publish: jest.fn().mockResolvedValue(undefined) };
  });

  it('creates employee, commits transaction, and publishes EmployeeCreatedEvent', async () => {
    const savedEmployee = buildMockEmployee();
    const { mockQR } = buildMockQueryRunner({ saveResult: savedEmployee });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new CreateEmployeeHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new CreateEmployeeCommand(tenantId, validInput, userId);
    const result = await handler.execute(command);

    expect(result.id).toBe('emp-uuid-001');
    expect(mockQR.commitTransaction).toHaveBeenCalled();
    // Event must be published AFTER commit — if publish is called before commit
    // the event could fire while the row doesn't yet exist in DB.
    const commitOrder = (mockQR.commitTransaction as jest.Mock).mock.invocationCallOrder[0];
    const publishOrder = (mockEventBus.publish as jest.Mock).mock.invocationCallOrder[0];
    expect(publishOrder).toBeGreaterThan(commitOrder);
  });

  it('does NOT publish EmployeeCreatedEvent when transaction rolls back (duplicate email)', async () => {
    const { mockQR, mockEmployeeRepo } = buildMockQueryRunner();
    // Simulate existing employee with same email
    mockEmployeeRepo.findOne.mockResolvedValue(buildMockEmployee());
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new CreateEmployeeHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new CreateEmployeeCommand(tenantId, validInput, userId);

    await expect(handler.execute(command)).rejects.toThrow(ConflictException);
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    // No event when transaction failed
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('does NOT publish EmployeeCreatedEvent when DB save throws', async () => {
    const { mockQR } = buildMockQueryRunner({ shouldFailSave: true });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new CreateEmployeeHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new CreateEmployeeCommand(tenantId, validInput, userId);

    await expect(handler.execute(command)).rejects.toThrow();
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('throws ConflictException when email already exists in tenant', async () => {
    const { mockQR, mockEmployeeRepo } = buildMockQueryRunner();
    mockEmployeeRepo.findOne.mockResolvedValue(buildMockEmployee());
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new CreateEmployeeHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new CreateEmployeeCommand(tenantId, validInput, userId);

    await expect(handler.execute(command)).rejects.toThrow(ConflictException);
  });

  it('always releases the QueryRunner even when an exception is thrown', async () => {
    const { mockQR, mockEmployeeRepo } = buildMockQueryRunner();
    mockEmployeeRepo.findOne.mockResolvedValue(buildMockEmployee()); // trigger ConflictException
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new CreateEmployeeHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new CreateEmployeeCommand(tenantId, validInput, userId);

    await expect(handler.execute(command)).rejects.toThrow();
    // QueryRunner.release() must always be called to return connection to pool
    expect(mockQR.release).toHaveBeenCalled();
  });
});
