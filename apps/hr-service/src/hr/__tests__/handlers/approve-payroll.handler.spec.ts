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
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, QueryRunner, EntityManager, Repository } from 'typeorm';
// CRITICAL-002 fix migrated approve-payroll from EventBus.publish() (post-
// commit, fire-and-forget) to OutboxPublisher.enqueue() (transactional
// outbox INSERT joining the same transaction as the domain write). Spec
// was still mocking EventBus.publish — strict-tsc surfaced the contract
// drift in PR-34 of the PROC-MEDIUM-007 ratchet.

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
    // payrolls.currency is NOT NULL and CreatePayrollHandler resolves it from
    // the tenant settings SSoT (HR-HIGH-008). The fixture omitted it, which no
    // real row can, so it exercised a shape the database forbids.
    currency: 'NOK',
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
  // `findOneResult` is intentionally `Payroll | null`; callers pass `null` to
  // exercise the not-found path. `??` would coalesce that legitimate `null`
  // into a default payroll, so distinguish "key present" from "key absent".
  const findOneResult =
    overrides && 'findOneResult' in overrides ? overrides.findOneResult : buildMockPayroll();

  // tenantManagerRepo() wraps this repo in TenantScopedRepository, whose
  // save() delegates to `this.repository.create(...)` then
  // `this.repository.save(...)`. The underlying repo therefore needs a
  // `create` method that echoes the entity it is handed.
  const mockPayrollRepo: Partial<Repository<Payroll>> = {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    create: jest.fn().mockImplementation((entity: Partial<Payroll>) =>
      Object.assign(new Payroll(), entity),
    ),
    save: jest.fn().mockImplementation((entity: Payroll) =>
      Promise.resolve(overrides?.saveResult ?? entity),
    ),
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
  let mockOutboxPublisher: Partial<OutboxPublisher>;

  const tenantId = 'tenant-uuid-001';
  const approverId = 'approver-user-001'; // different from createdBy

  beforeEach(() => {
    jest.clearAllMocks();
    mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  });

  it('approves payroll, commits transaction, and publishes PayrollProcessedEvent', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.PENDING_APPROVAL });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);
    const result = await handler.execute(command);

    expect(mockQR.commitTransaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalled();
  });

  it('refuses to publish PayrollProcessed for a payroll with no currency (HR-HIGH-008)', async () => {
    // The handler used to read `savedPayroll.currency || 'USD'`, so a row that
    // somehow lost its currency produced a USD-denominated event crossing into
    // the finance ledger under a currency nobody chose. The column is NOT NULL
    // and has no default any more, so this state is a data defect: fail the
    // approval and leave it visible rather than mint the event.
    const payroll = buildMockPayroll({ currency: '' });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(
      mockDataSource as DataSource,
      mockOutboxPublisher as OutboxPublisher,
    );

    await expect(
      handler.execute(new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId)),
    ).rejects.toThrow(BadRequestException);
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
  });

  it('stamps the payroll row currency onto the event, never a literal (HR-HIGH-008)', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.PENDING_APPROVAL, currency: 'SEK' });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(
      mockDataSource as DataSource,
      mockOutboxPublisher as OutboxPublisher,
    );
    await handler.execute(new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId));

    const [event] = (mockOutboxPublisher.enqueue as jest.Mock).mock.calls[0] as [
      { currency: string },
    ];
    expect(event.currency).toBe('SEK');
    expect(event.currency).not.toBe('USD');
  });

  it('throws BadRequestException when approver is the creator (self-approval prevention)', async () => {
    // MAKER-CHECKER: the person who created the payroll cannot also approve it.
    const creatorId = 'manager-user-001';
    const payroll = buildMockPayroll({ createdBy: creatorId });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', creatorId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    // No event when self-approval was blocked
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when payroll status is APPROVED (already processed)', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.APPROVED });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when payroll status is CANCELLED', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.CANCELLED });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when payroll not found for tenant', async () => {
    const { mockQR } = buildMockQueryRunner({ findOneResult: null });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'non-existent-id', approverId);

    await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
  });

  it('allows approval of DRAFT status payroll', async () => {
    const payroll = buildMockPayroll({ status: PayrollStatus.DRAFT });
    const { mockQR } = buildMockQueryRunner({ findOneResult: payroll });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'payroll-uuid-001', approverId);

    await expect(handler.execute(command)).resolves.toBeDefined();
  });

  it('always releases QueryRunner even on exception', async () => {
    const { mockQR } = buildMockQueryRunner({ findOneResult: null });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };

    handler = new ApprovePayrollHandler(mockDataSource as DataSource, mockOutboxPublisher as OutboxPublisher);
    const command = new ApprovePayrollCommand(tenantId, 'non-existent-id', approverId);

    await expect(handler.execute(command)).rejects.toThrow();
    expect(mockQR.release).toHaveBeenCalled();
  });
});
