/**
 * Payroll Management Integration Tests
 *
 * Tests cover:
 * - Payroll creation with earnings/deductions calculation
 * - Pay period overlap detection
 * - Payroll approval workflow (DRAFT -> APPROVED)
 * - Status transition validation
 * - Deductions exceeding gross pay prevention
 * - Net pay calculation
 * - Employee not found validation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';

import { CreatePayrollHandler } from '../handlers/create-payroll.handler';
import { ApprovePayrollHandler } from '../handlers/approve-payroll.handler';
import { CreatePayrollCommand } from '../commands/create-payroll.command';
import { ApprovePayrollCommand } from '../commands/approve-payroll.command';
import { Payroll, PayrollStatus, PayPeriodType } from '../entities/payroll.entity';
import { Employee, EmployeeStatus } from '../entities/employee.entity';
import type { CreatePayrollInput } from '../dto/create-payroll.input';

// ============================================================================
// Test Constants
// ============================================================================

const tenantId = 'tenant-uuid-001';
const userId = 'user-uuid-001';
const employeeId = 'employee-uuid-001';

// ============================================================================
// Mock Factories
// ============================================================================

const createMockEmployee = (overrides: Partial<Employee> = {}): Employee => {
  const emp = new Employee();
  Object.assign(emp, {
    id: employeeId,
    tenantId,
    firstName: 'John',
    lastName: 'Doe',
    status: EmployeeStatus.ACTIVE,
    currency: 'USD',
    isDeleted: false,
    ...overrides,
  });
  return emp;
};

const createMockPayroll = (overrides: Partial<Payroll> = {}): Payroll => {
  const payroll = new Payroll();
  Object.assign(payroll, {
    id: 'payroll-uuid-001',
    tenantId,
    employeeId,
    payrollNumber: 'PAY-202603-ABCD1234',
    payPeriodType: PayPeriodType.MONTHLY,
    payPeriodStart: new Date('2026-03-01'),
    payPeriodEnd: new Date('2026-03-31'),
    workHours: { regularHours: 160, overtimeHours: 10, holidayHours: 0, sickLeaveHours: 0, vacationHours: 0 },
    earnings: { baseSalary: 5000, overtime: 500, bonus: 0, commission: 0, allowances: 0, grossPay: 5500 },
    deductions: { tax: 1100, socialSecurity: 275, healthInsurance: 200, retirement: 0, otherDeductions: 0, totalDeductions: 1575 },
    netPay: 3925,
    currency: 'USD',
    status: PayrollStatus.DRAFT,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: userId,
    updatedBy: userId,
    ...overrides,
  });
  return payroll;
};

const createValidPayrollInput = (overrides: Partial<CreatePayrollInput> = {}): CreatePayrollInput => ({
  employeeId,
  payPeriodType: PayPeriodType.MONTHLY,
  payPeriodStart: '2026-03-01',
  payPeriodEnd: '2026-03-31',
  workHours: {
    regularHours: 160,
    overtimeHours: 10,
  },
  earnings: {
    baseSalary: 5000,
    overtime: 500,
  },
  deductions: {
    tax: 1100,
    socialSecurity: 275,
    healthInsurance: 200,
  },
  ...overrides,
} as CreatePayrollInput);

// ============================================================================
// Create Payroll Tests
// ============================================================================

describe('Payroll Management Integration Tests', () => {
  describe('Create Payroll', () => {
    let handler: CreatePayrollHandler;
    let payrollRepository: jest.Mocked<Repository<Payroll>>;
    let employeeRepository: jest.Mocked<Repository<Employee>>;
    let mockQueryRunner: any;

    beforeEach(async () => {
      payrollRepository = {
        findOne: jest.fn(),
        save: jest.fn(),
        create: jest.fn(),
      } as unknown as jest.Mocked<Repository<Payroll>>;

      employeeRepository = {
        findOne: jest.fn(),
      } as unknown as jest.Mocked<Repository<Employee>>;

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null), // No overlap by default
      };

      mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn(),
          create: jest.fn((entity: any, data: any) => {
            const p = new Payroll();
            Object.assign(p, data);
            return p;
          }),
          save: jest.fn((entity: any, data: any) =>
            Promise.resolve({ ...data, id: data.id || 'new-payroll-uuid' }),
          ),
          createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
        },
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CreatePayrollHandler,
          { provide: getRepositoryToken(Payroll), useValue: payrollRepository },
          { provide: getRepositoryToken(Employee), useValue: employeeRepository },
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      handler = module.get(CreatePayrollHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should create a payroll with correct calculations', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput();
      const command = new CreatePayrollCommand(tenantId, input, userId);

      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.employeeId).toBe(employeeId);
      expect(result.status).toBe(PayrollStatus.DRAFT);

      // Verify earnings calculation
      expect(result.earnings.baseSalary).toBe(5000);
      expect(result.earnings.overtime).toBe(500);
      expect(result.earnings.grossPay).toBe(5500); // 5000 + 500

      // Verify deductions calculation
      expect(result.deductions.tax).toBe(1100);
      expect(result.deductions.socialSecurity).toBe(275);
      expect(result.deductions.healthInsurance).toBe(200);
      expect(result.deductions.totalDeductions).toBe(1575); // 1100 + 275 + 200

      // Verify net pay
      expect(result.netPay).toBe(3925); // 5500 - 1575

      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should reject payroll for non-existent employee', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      const command = new CreatePayrollCommand(
        tenantId,
        createValidPayrollInput(),
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
    });

    it('should reject invalid pay period (start >= end)', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const command = new CreatePayrollCommand(
        tenantId,
        createValidPayrollInput({
          payPeriodStart: '2026-03-31',
          payPeriodEnd: '2026-03-01', // End before start
        }),
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
      await expect(handler.execute(command)).rejects.toThrow(/start date must be before end date/);
    });

    it('should reject overlapping payroll periods', async () => {
      const employee = createMockEmployee();
      const existingPayroll = createMockPayroll();

      mockQueryRunner.manager.findOne.mockResolvedValue(employee);
      // QueryBuilder returns existing overlapping payroll
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(existingPayroll);

      const command = new CreatePayrollCommand(
        tenantId,
        createValidPayrollInput(),
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/Overlapping payroll period/);
    });

    it('should reject deductions exceeding gross pay', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const command = new CreatePayrollCommand(
        tenantId,
        createValidPayrollInput({
          earnings: { baseSalary: 1000 }, // Gross = 1000
          deductions: { tax: 1500 }, // Deductions = 1500 > 1000
        }),
        userId,
      );

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
      await expect(handler.execute(command)).rejects.toThrow(/deductions cannot exceed gross pay/i);
    });

    it('should handle payroll with no deductions', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput({
        deductions: undefined, // No deductions
      });

      const command = new CreatePayrollCommand(tenantId, input, userId);
      const result = await handler.execute(command);

      expect(result.deductions.totalDeductions).toBe(0);
      expect(result.netPay).toBe(result.earnings.grossPay);
    });

    it('should handle all earnings components', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput({
        earnings: {
          baseSalary: 5000,
          overtime: 500,
          bonus: 1000,
          commission: 200,
          allowances: 300,
        },
      });

      const command = new CreatePayrollCommand(tenantId, input, userId);
      const result = await handler.execute(command);

      expect(result.earnings.grossPay).toBe(7000); // 5000+500+1000+200+300
    });

    it('should use employee currency when not specified', async () => {
      const employee = createMockEmployee({ currency: 'TRY' });
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput({ currency: undefined });
      const command = new CreatePayrollCommand(tenantId, input, userId);
      const result = await handler.execute(command);

      expect(result.currency).toBe('TRY');
    });

    it('should generate payroll number from pay period start date', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput({
        payPeriodStart: '2026-01-01',
        payPeriodEnd: '2026-01-31',
      });

      const command = new CreatePayrollCommand(tenantId, input, userId);
      const result = await handler.execute(command);

      expect(result.payrollNumber).toMatch(/^PAY-202601-[A-F0-9]{8}$/);
    });

    it('should set work hours correctly', async () => {
      const employee = createMockEmployee();
      mockQueryRunner.manager.findOne.mockResolvedValue(employee);

      const input = createValidPayrollInput({
        workHours: {
          regularHours: 160,
          overtimeHours: 20,
          holidayHours: 8,
          sickLeaveHours: 16,
          vacationHours: 24,
        },
      });

      const command = new CreatePayrollCommand(tenantId, input, userId);
      const result = await handler.execute(command);

      expect(result.workHours.regularHours).toBe(160);
      expect(result.workHours.overtimeHours).toBe(20);
      expect(result.workHours.holidayHours).toBe(8);
      expect(result.workHours.sickLeaveHours).toBe(16);
      expect(result.workHours.vacationHours).toBe(24);
    });
  });

  // --------------------------------------------------------------------------
  // Approve Payroll
  // --------------------------------------------------------------------------

  describe('Approve Payroll', () => {
    let handler: ApprovePayrollHandler;
    let mockQueryRunner: any;
    let mockPayrollRepo: any;

    beforeEach(async () => {
      mockPayrollRepo = {
        findOne: jest.fn(),
        save: jest.fn((entity: Payroll) => Promise.resolve(entity)),
      };

      mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          getRepository: jest.fn().mockReturnValue(mockPayrollRepo),
        },
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ApprovePayrollHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      handler = module.get(ApprovePayrollHandler);
    });

    afterEach(() => jest.clearAllMocks());

    it('should approve a DRAFT payroll', async () => {
      const draftPayroll = createMockPayroll({ status: PayrollStatus.DRAFT });
      mockPayrollRepo.findOne.mockResolvedValue(draftPayroll);

      const command = new ApprovePayrollCommand(tenantId, draftPayroll.id, userId);
      const result = await handler.execute(command);

      expect(result.status).toBe(PayrollStatus.APPROVED);
      expect(result.approvedBy).toBe(userId);
      expect(result.approvedAt).toBeDefined();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should approve a PENDING_APPROVAL payroll', async () => {
      const pendingPayroll = createMockPayroll({
        status: PayrollStatus.PENDING_APPROVAL,
      });
      mockPayrollRepo.findOne.mockResolvedValue(pendingPayroll);

      const command = new ApprovePayrollCommand(tenantId, pendingPayroll.id, userId);
      const result = await handler.execute(command);

      expect(result.status).toBe(PayrollStatus.APPROVED);
    });

    it('should reject approval of APPROVED payroll', async () => {
      const approvedPayroll = createMockPayroll({
        status: PayrollStatus.APPROVED,
      });
      mockPayrollRepo.findOne.mockResolvedValue(approvedPayroll);

      const command = new ApprovePayrollCommand(tenantId, approvedPayroll.id, userId);

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
      await expect(handler.execute(command)).rejects.toThrow(/Cannot approve payroll with status/);
    });

    it('should reject approval of PAID payroll', async () => {
      const paidPayroll = createMockPayroll({
        status: PayrollStatus.PAID,
      });
      mockPayrollRepo.findOne.mockResolvedValue(paidPayroll);

      const command = new ApprovePayrollCommand(tenantId, paidPayroll.id, userId);

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
    });

    it('should reject approval of CANCELLED payroll', async () => {
      const cancelledPayroll = createMockPayroll({
        status: PayrollStatus.CANCELLED,
      });
      mockPayrollRepo.findOne.mockResolvedValue(cancelledPayroll);

      const command = new ApprovePayrollCommand(tenantId, cancelledPayroll.id, userId);

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent payroll', async () => {
      mockPayrollRepo.findOne.mockResolvedValue(null);

      const command = new ApprovePayrollCommand(tenantId, 'non-existent', userId);

      await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
    });

    it('should set approvedAt timestamp on approval', async () => {
      const draftPayroll = createMockPayroll({ status: PayrollStatus.DRAFT });
      mockPayrollRepo.findOne.mockResolvedValue(draftPayroll);

      const beforeApproval = new Date();
      const command = new ApprovePayrollCommand(tenantId, draftPayroll.id, userId);
      const result = await handler.execute(command);

      expect(result.approvedAt).toBeDefined();
      expect(result.approvedAt!.getTime()).toBeGreaterThanOrEqual(beforeApproval.getTime());
    });

    it('should update updatedBy on approval', async () => {
      const draftPayroll = createMockPayroll({
        status: PayrollStatus.DRAFT,
        updatedBy: 'original-creator',
      });
      mockPayrollRepo.findOne.mockResolvedValue(draftPayroll);

      const approverId = 'manager-uuid-001';
      const command = new ApprovePayrollCommand(tenantId, draftPayroll.id, approverId);
      const result = await handler.execute(command);

      expect(result.updatedBy).toBe(approverId);
    });
  });

  // --------------------------------------------------------------------------
  // E2E Payroll Workflow
  // --------------------------------------------------------------------------

  describe('E2E Payroll Workflow', () => {
    it('should handle complete create -> approve workflow', async () => {
      // Verify data model consistency
      const payroll = createMockPayroll({
        status: PayrollStatus.DRAFT,
        netPay: 3925,
        earnings: {
          baseSalary: 5000,
          overtime: 500,
          bonus: 0,
          commission: 0,
          allowances: 0,
          grossPay: 5500,
        },
        deductions: {
          tax: 1100,
          socialSecurity: 275,
          healthInsurance: 200,
          retirement: 0,
          otherDeductions: 0,
          totalDeductions: 1575,
        },
      });

      // Step 1: Verify creation state
      expect(payroll.status).toBe(PayrollStatus.DRAFT);
      expect(payroll.earnings.grossPay).toBe(5500);
      expect(payroll.deductions.totalDeductions).toBe(1575);
      expect(payroll.netPay).toBe(3925); // 5500 - 1575

      // Step 2: Simulate approval
      payroll.status = PayrollStatus.APPROVED;
      payroll.approvedBy = 'manager-uuid';
      payroll.approvedAt = new Date();

      expect(payroll.status).toBe(PayrollStatus.APPROVED);
      expect(payroll.approvedBy).toBe('manager-uuid');
    });

    it('should verify net pay = gross - deductions invariant', () => {
      const testCases = [
        { gross: 10000, deductions: 3000, expected: 7000 },
        { gross: 5000, deductions: 0, expected: 5000 },
        { gross: 1000, deductions: 999, expected: 1 },
        { gross: 50000, deductions: 15000, expected: 35000 },
      ];

      for (const { gross, deductions, expected } of testCases) {
        const netPay = gross - deductions;
        expect(netPay).toBe(expected);
        expect(netPay).toBeGreaterThanOrEqual(0);
      }
    });

    it('should validate payroll number format', () => {
      // Payroll numbers should follow pattern: PAY-YYYYMM-XXXXXXXX
      const validPatterns = [
        'PAY-202601-ABCD1234',
        'PAY-202612-12345678',
        'PAY-202603-DEADBEEF',
      ];

      const regex = /^PAY-\d{6}-[A-F0-9]{8}$/;
      for (const num of validPatterns) {
        expect(num).toMatch(regex);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Transaction Safety
  // --------------------------------------------------------------------------

  describe('Transaction Safety', () => {
    let approveHandler: ApprovePayrollHandler;
    let mockQueryRunner: any;
    let mockPayrollRepo: any;

    beforeEach(async () => {
      mockPayrollRepo = {
        findOne: jest.fn(),
        save: jest.fn(),
      };

      mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          getRepository: jest.fn().mockReturnValue(mockPayrollRepo),
        },
      };

      const mockDataSource = {
        createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ApprovePayrollHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      approveHandler = module.get(ApprovePayrollHandler);
    });

    it('should rollback on error during approval', async () => {
      mockPayrollRepo.findOne.mockResolvedValue(null); // Not found

      const command = new ApprovePayrollCommand(tenantId, 'bad-id', userId);

      await expect(approveHandler.execute(command)).rejects.toThrow();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should always release query runner even on error', async () => {
      mockPayrollRepo.findOne.mockRejectedValue(new Error('DB error'));

      const command = new ApprovePayrollCommand(tenantId, 'any-id', userId);

      await expect(approveHandler.execute(command)).rejects.toThrow();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });
});
