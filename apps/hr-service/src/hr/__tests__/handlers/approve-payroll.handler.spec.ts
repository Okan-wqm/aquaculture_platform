/**
 * WHY THIS FILE EXISTS:
 * ApprovePayrollHandler enforces two critical business rules:
 * 1. Self-approval prevention (maker-checker: creator cannot approve their own payroll)
 * 2. Status validation (only DRAFT or PENDING_APPROVAL can be approved)
 *
 * After the HR-expert audit fix, it also publishes PayrollProcessedEvent.
 * Without tests these rules had no automated coverage — a regression would
 * allow employees to approve their own salary records.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { DataSource, QueryRunner, EntityManager, Repository } from 'typeorm';

import { ApprovePayrollCommand } from '../../commands/approve-payroll.command';
import { ApprovePayrollHandler } from '../../handlers/approve-payroll.handler';
import { Payroll, PayrollStatus } from '../../entities/payroll.entity';

// ============================================================================
// Mock Helpers
// ============================================================================

const buildMockPayroll = (overrides: Partial<Payroll> = {}): Payroll => {
  const p = new Payroll();
  Object.assign(p, {
    id: 'payroll-uuid-001',
    tenantId: 'tenant-uuid-001',
    employeeId: 'emp-uuid-001',
    payrollNumber: 'PAY-2026-001',
    status: PayrollStatus.PENDING_APPROVAL,
    netPay: 5000,
    payPeriodStart: new Date('2026-03-01'),
    payPeriodEnd: new Date('2026-03-31'),
    createdBy: 'manager-user-001',
    approvedBy: undefined,
    ...overrides,
  });
  return p;
};

// ============================================================================
// Mock Setup
// ============================================================================

const buildMockQueryRunner = (overrides?: {
  findOneResult?: Payroll | null;
  saveResult?: Payroll;
}) => {
  const mockPayrollRepo: Partial<Repository<Payroll>> = {
    findOne: jest.fn().mockResolvedValue(overrides?.findOneResult ?? buildMockPayroll()),
    save: jest.fn().mockResolvedValue(overrides?.saveResult ?? { ...buildMockPayroll(), status: PayrollStatus.APPROVED }),
  };

  const mockManager: Partial<EntityManager> = {
    getRepository: jest.fn().mockReturnValue(mockPayrollRepo),
  };

  const mockQR: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: mockManager as EntityManager,
  };

  return { mockQR, mockPayrollRepo };
};

describe('ApprovePayrollHandler', () => {
  let handler: ApprovePayrollHandler;
  let mockDataSource: Partial<DataSource>;
  let mockEventBus: Partial<EventBus>;

  const tenantId = 'tenant-uuid-001';
  const approverId = 'approver-user-001'; // different from createdBy

  beforeEach(() => {
    jest.clearAllMocks();
    mockEventBus = { publish: jest.fn().mockResolvedValue(undefined) };
  });

  it('approves payroll, commits transaction, and publishes PayrollProcessedEvent', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.PENDING_APPROVAL });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);
    const result = await handler.execute(command);

    expect(mockQR.commitTransaction).toHaveBeenCalled();
    expect(mockEventBus.publish).toHaveBeenCalled();
  });

  it('throws BadRequestException when approver is the creator (self-approval prevention)', async () => {
    // MAKER-CHECKER: the person who created the payroll cannot also approve it.
    const creatorId = 'manager-user-001';
    const payroll = buildMockPayroll({ createdBy: creatorId });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', creatorId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    // No event when self-approval was blocked
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when payroll status is APPROVED (already processed)', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.APPROVED });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when payroll status is CANCELLED', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.CANCELLED });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when payroll not found for tenant', async () => {
    const { mockQR } = buildMockQueryRunner({ findOneResult: null });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'non-existent-id', approverId);

    await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
  });

  it('allows approval of DRAFT status payroll', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.DRAFT });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).resolves.toBeDefined();
  });

  it('always releases QueryRunner even on exception', async () => {
    const { mockQR } = buildMockQueryRunner({ findOneResult: null });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockEventBus as EventBus);
    const command = new ApprovePayrollCommand(tenantId, 'non-existent-id', approverId);

    await expect(handler.execute(command)).rejects.toThrow();
    expect(mockQR.release).toHaveBeenCalled();
  });
});
