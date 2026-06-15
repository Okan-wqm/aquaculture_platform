/**
 * ApprovePurchaseOrderHandler + VALID_TRANSITIONS unit tests.
 *
 * Covers the maker-checker approval gate (SOC2 CC3.4):
 *   - approval requires status === SUBMITTED (else BadRequestException);
 *   - the creator cannot self-approve (createdBy === userId → ForbiddenException);
 *   - the happy path sets APPROVED + the approvedBy/approvedByName/approvedAt audit;
 *   - the state machine makes ORDERED reachable ONLY from APPROVED, so a spend can
 *     never be placed without passing the checker gate.
 *
 * London-school: the DataSource/transaction + repositories are mocked via the
 * shared @aquaculture/testing factories (no hand-rolled casts). The handler persists
 * through the tenant-scoped path (tenantManagerRepo → manager.getRepository), which
 * we route to a controllable inner repo whose save() echoes the entity back.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

// transaction()'s isolation-level union (e.g. 'SERIALIZABLE') is not re-exported
// from the typeorm barrel; derive it from the overload itself so the mock impl
// matches the inferred 2-arg signature without a fragile driver-path import.
type TransactionIsolationLevel = Parameters<DataSource['transaction']>[0];

import { ApprovePurchaseOrderHandler } from '../approve-purchase-order.handler';
import { ApprovePurchaseOrderCommand } from '../../commands/approve-purchase-order.command';
import { VALID_TRANSITIONS } from '../update-purchase-order-status.handler';
import { PurchaseOrder, PurchaseOrderStatus, PurchaseOrderCategory } from '../../entities/purchase-order.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CREATOR = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';

describe('ApprovePurchaseOrderHandler', () => {
  let handler: ApprovePurchaseOrderHandler;
  let poRepository: jest.Mocked<Repository<PurchaseOrder>>;
  // Inner repo reached via tenantManagerRepo(manager, PurchaseOrder, tenantId).
  let innerPoRepo: jest.Mocked<Repository<PurchaseOrder>>;
  const { mockDataSource, mockManager } = createMockDataSource();

  const makePo = (overrides: Partial<PurchaseOrder> = {}): PurchaseOrder =>
    Object.assign(new PurchaseOrder(), {
      id: 'po-1',
      tenantId: TENANT,
      orderNumber: 'PO-0001',
      category: PurchaseOrderCategory.FEED,
      supplierName: 'Acme Feeds',
      status: PurchaseOrderStatus.SUBMITTED,
      currency: 'NOK',
      createdBy: CREATOR,
      isDeleted: false,
      items: [],
      ...overrides,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    poRepository = createMockRepository<PurchaseOrder>();
    innerPoRepo = createMockRepository<PurchaseOrder>();
    // TenantScopedRepository.save() does create() then save() on this inner repo;
    // echo both so the handler's mutations flow back into the returned entity.
    innerPoRepo.create.mockImplementation((data: unknown) => data as PurchaseOrder);
    innerPoRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as PurchaseOrder));

    // Route the manager-scoped PurchaseOrder repository to the controllable repo.
    // DRIVE through mockReturnValue so getRepository's typed MockInstance signature
    // stays intact instead of being clobbered by an assignment.
    mockManager.getRepository.mockReturnValue(innerPoRepo);
    // dataSource.transaction(cb) immediately invokes cb with the mock manager.
    // The factory's mockDataSource has no `transaction` member, so install a
    // bare jest.fn (assignable to the overloaded MockInstance type) and set its
    // behaviour via mockImplementation. jest infers transaction()'s LAST
    // overload — (isolationLevel, runInTransaction) — so the impl declares both
    // params, then runtime-narrows: the handler calls the single-callback
    // overload where the FIRST arg IS the callback (and the 2nd is undefined),
    // so whichever arg is the function is invoked with the mock manager.
    mockDataSource.transaction = jest.fn();
    mockDataSource.transaction.mockImplementation(
      (
        isolationOrRun: TransactionIsolationLevel | ((m: EntityManager) => Promise<unknown>),
        runInTransaction: (m: EntityManager) => Promise<unknown>,
      ) => {
        const run = typeof isolationOrRun === 'function' ? isolationOrRun : runInTransaction;
        return run(mockManager);
      },
    );

    handler = new ApprovePurchaseOrderHandler(poRepository, mockDataSource);
  });

  it('throws NotFoundException when the purchase order does not exist', async () => {
    poRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new ApprovePurchaseOrderCommand('missing', TENANT, APPROVER, 'Anne Approver')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects approval when the status is not SUBMITTED (BadRequestException)', async () => {
    poRepository.findOne.mockResolvedValueOnce(makePo({ status: PurchaseOrderStatus.DRAFT }));

    await expect(
      handler.execute(new ApprovePurchaseOrderCommand('po-1', TENANT, APPROVER, 'Anne Approver')),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(innerPoRepo.save).not.toHaveBeenCalled();
  });

  it('blocks self-approval — creator cannot approve their own PO (ForbiddenException, SOC2 CC3.4)', async () => {
    poRepository.findOne.mockResolvedValueOnce(makePo({ createdBy: APPROVER }));

    await expect(
      handler.execute(new ApprovePurchaseOrderCommand('po-1', TENANT, APPROVER, 'Self Approver')),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(innerPoRepo.save).not.toHaveBeenCalled();
  });

  it('approves a SUBMITTED PO by a different user and stamps the audit trail', async () => {
    poRepository.findOne.mockResolvedValueOnce(makePo());

    const before = Date.now();
    const result = await handler.execute(
      new ApprovePurchaseOrderCommand('po-1', TENANT, APPROVER, 'Anne Approver'),
    );
    const after = Date.now();

    expect(result.status).toBe(PurchaseOrderStatus.APPROVED);
    expect(result.approvedBy).toBe(APPROVER);
    expect(result.approvedByName).toBe('Anne Approver');
    expect(result.approvedAt).toBeInstanceOf(Date);
    expect(result.approvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.approvedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(innerPoRepo.save).toHaveBeenCalledTimes(1);
  });

  it('looks the PO up scoped to tenant and excluding soft-deleted rows', async () => {
    poRepository.findOne.mockResolvedValueOnce(makePo());

    await handler.execute(new ApprovePurchaseOrderCommand('po-1', TENANT, APPROVER, 'Anne Approver'));

    expect(poRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'po-1', tenantId: TENANT, isDeleted: false },
      relations: ['items'],
    });
  });
});

describe('VALID_TRANSITIONS (purchase order state machine)', () => {
  it('does NOT allow the generic status mutation to reach APPROVED from any state', () => {
    for (const [from, allowed] of Object.entries(VALID_TRANSITIONS)) {
      expect(allowed).not.toContain(PurchaseOrderStatus.APPROVED);
      // sanity: a state never lists itself as a destination
      expect(allowed).not.toContain(from);
    }
  });

  it('makes ORDERED reachable ONLY from APPROVED (the spend cannot bypass the checker gate)', () => {
    const statesAllowingOrdered = Object.entries(VALID_TRANSITIONS)
      .filter(([, allowed]) => allowed.includes(PurchaseOrderStatus.ORDERED))
      .map(([from]) => from);

    expect(statesAllowingOrdered).toEqual([PurchaseOrderStatus.APPROVED]);
  });

  it('models the maker-checker hand-off: DRAFT -> SUBMITTED and SUBMITTED -> DRAFT (no self-approve path)', () => {
    expect(VALID_TRANSITIONS[PurchaseOrderStatus.DRAFT]).toEqual(
      expect.arrayContaining([PurchaseOrderStatus.SUBMITTED, PurchaseOrderStatus.CANCELLED]),
    );
    expect(VALID_TRANSITIONS[PurchaseOrderStatus.SUBMITTED]).toEqual(
      expect.arrayContaining([PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CANCELLED]),
    );
    expect(VALID_TRANSITIONS[PurchaseOrderStatus.DRAFT]).not.toContain(PurchaseOrderStatus.ORDERED);
  });

  it('keeps RECEIVED and CANCELLED terminal', () => {
    expect(VALID_TRANSITIONS[PurchaseOrderStatus.RECEIVED]).toEqual([]);
    expect(VALID_TRANSITIONS[PurchaseOrderStatus.CANCELLED]).toEqual([]);
  });
});
