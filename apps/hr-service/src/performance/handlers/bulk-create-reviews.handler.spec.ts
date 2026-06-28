/**
 * WHY THIS FILE EXISTS:
 * BulkCreateReviewsHandler is the backend for the FE `BulkCreateReviews`
 * mutation (performance.operations.ts). Before this handler the mutation 400'd
 * (GraphQL FE↔backend drift). Tests pin the contract:
 *  - creates every valid spec in ONE transaction and commits (happy path)
 *  - SKIPS invalid specs (unknown employee, bad period, duplicate) with an
 *    error string instead of aborting the batch (validation path)
 *  - employee/reviewer lookups + the insert go through tenantManagerRepo, so the
 *    tenantId is injected on every query (tenant-scoping path)
 *
 * Mocking idiom mirrors update-shift.handler.spec.ts: the mock
 * EntityManager.getRepository returns a mock repo which tenantManagerRepo wraps
 * in a real TenantScopedRepository (exercising the actual tenant-scoping wrapper).
 */
import { DataSource, QueryRunner, EntityManager } from 'typeorm';

import { BulkCreateReviewsHandler } from './bulk-create-reviews.handler';
import { BulkCreateReviewsCommand, BulkReviewSpec } from '../commands/bulk-create-reviews.command';
import { PerformanceReview } from '../entities/performance-review.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { ReviewPeriodType } from '../entities/performance-review.entity';

const tenantId = 'tenant-uuid-001';
const userId = 'admin-user-001';

const spec = (overrides: Partial<BulkReviewSpec> = {}): BulkReviewSpec => ({
  employeeId: 'emp-A',
  reviewerId: 'rev-A',
  periodType: ReviewPeriodType.ANNUAL,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  ...overrides,
});

/**
 * Build the transactional mocks. `knownEmployeeIds` controls which employee /
 * reviewer ids resolve; `existingReviewKeys` controls the de-dupe lookup.
 */
const buildQueryRunner = (opts: {
  knownEmployeeIds: Set<string>;
  existingReviewEmployeeIds?: Set<string>;
}) => {
  const saved: Partial<PerformanceReview>[] = [];

  const employeeRepo = {
    findOne: jest.fn().mockImplementation((q: { where: { id: string } }) =>
      Promise.resolve(
        opts.knownEmployeeIds.has(q.where.id)
          ? Object.assign(new Employee(), { id: q.where.id, tenantId, isDeleted: false })
          : null,
      ),
    ),
  };

  const reviewRepo = {
    findOne: jest.fn().mockImplementation((q: { where: { employeeId: string } }) =>
      Promise.resolve(
        opts.existingReviewEmployeeIds?.has(q.where.employeeId)
          ? Object.assign(new PerformanceReview(), { id: 'existing', employeeId: q.where.employeeId })
          : null,
      ),
    ),
    create: jest.fn().mockImplementation((data: Partial<PerformanceReview>) =>
      Object.assign(new PerformanceReview(), data),
    ),
    save: jest.fn().mockImplementation((entity: PerformanceReview) => {
      saved.push(entity);
      return Promise.resolve(entity);
    }),
  };

  // tenantManagerRepo routes through the manager's per-entity repo lookup; map each entity to its mock.
  const mockManager: Partial<EntityManager> = {
    getRepository: jest.fn().mockImplementation((entity: unknown) =>
      entity === Employee ? employeeRepo : reviewRepo,
    ),
  };

  const mockQR: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: mockManager as EntityManager,
  };

  return { mockQR, reviewRepo, saved };
};

/**
 * The handler only ever calls dataSource.createQueryRunner(); model the mock as a
 * Partial<DataSource> and hand it over with a single `as DataSource` (Partial→full
 * structurally overlaps, so no double cast is needed).
 */
const buildDataSource = (mockQR: Partial<QueryRunner>): DataSource => {
  const mockDataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(mockQR),
  };
  return mockDataSource as DataSource;
};

describe('BulkCreateReviewsHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates all valid reviews in one transaction and commits (happy path)', async () => {
    const { mockQR, saved } = buildQueryRunner({
      knownEmployeeIds: new Set(['emp-A', 'emp-B', 'rev-A']),
    });
    const handler = new BulkCreateReviewsHandler(buildDataSource(mockQR));

    const result = await handler.execute(
      new BulkCreateReviewsCommand(tenantId, userId, [
        spec({ employeeId: 'emp-A' }),
        spec({ employeeId: 'emp-B' }),
      ]),
    );

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(saved).toHaveLength(2);
    // stamps createdBy/updatedBy from the acting user, single commit
    expect(saved[0]?.createdBy).toBe(userId);
    expect(mockQR.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips invalid specs (unknown employee, bad period, duplicate) with errors (validation path)', async () => {
    const { mockQR, saved } = buildQueryRunner({
      knownEmployeeIds: new Set(['emp-A', 'emp-DUP', 'rev-A']),
      existingReviewEmployeeIds: new Set(['emp-DUP']),
    });
    const handler = new BulkCreateReviewsHandler(buildDataSource(mockQR));

    const result = await handler.execute(
      new BulkCreateReviewsCommand(tenantId, userId, [
        spec({ employeeId: 'emp-A' }), // valid
        spec({ employeeId: 'emp-MISSING' }), // unknown employee
        spec({ employeeId: 'emp-A', periodStart: '2026-12-31', periodEnd: '2026-01-01' }), // bad period
        spec({ employeeId: 'emp-DUP' }), // duplicate review exists
      ]),
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.errors).toHaveLength(3);
    expect(saved).toHaveLength(1);
    // batch still commits — partial success is the contract
    expect(mockQR.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('injects the tenantId on the persisted review (tenant-scoping path)', async () => {
    const { mockQR, saved } = buildQueryRunner({
      knownEmployeeIds: new Set(['emp-A', 'rev-A']),
    });
    const handler = new BulkCreateReviewsHandler(buildDataSource(mockQR));

    await handler.execute(
      new BulkCreateReviewsCommand(tenantId, userId, [spec({ employeeId: 'emp-A' })]),
    );

    expect(saved[0]?.tenantId).toBe(tenantId);
  });

  it('rolls back and releases the QueryRunner when persistence throws', async () => {
    const { mockQR, reviewRepo } = buildQueryRunner({
      knownEmployeeIds: new Set(['emp-A', 'rev-A']),
    });
    reviewRepo.save.mockRejectedValueOnce(new Error('DB error'));
    const handler = new BulkCreateReviewsHandler(buildDataSource(mockQR));

    await expect(
      handler.execute(new BulkCreateReviewsCommand(tenantId, userId, [spec({ employeeId: 'emp-A' })])),
    ).rejects.toThrow();
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    expect(mockQR.release).toHaveBeenCalled();
  });
});
