/**
 * BatchHarvestEligibilityService Unit Tests
 *
 * Covers the invariant: a batch cannot be harvested while any active
 * HealthEvent has an earliestHarvestDate past the requested harvest
 * date. Drives the compliance gate in createHarvestRecord (see
 * docs/illustrator/ — Girdi 14h).
 *
 * Architecture: the service reads health_events through the fail-closed
 * runInTenantRead boundary, so the test drives it with createMockDataSource
 * (runInTenantRead-aware) and stubs the boundary manager's `find`.
 */
import { createMockDataSource } from '@aquaculture/testing';
import { BatchHarvestEligibilityService } from '../services/batch-harvest-eligibility.service';
import {
  HealthEvent,
  HealthEventStatus,
} from '../entities/health-event.entity';

type HealthEventRow = Pick<
  HealthEvent,
  | 'id'
  | 'title'
  | 'diseaseName'
  | 'earliestHarvestDate'
  | 'withdrawalPeriodDays'
  | 'status'
>;

function makeService(rows: HealthEventRow[]): {
  service: BatchHarvestEligibilityService;
  scopedRepo: { find: jest.Mock };
} {
  const { mockDataSource, mockManager } = createMockDataSource();
  // tenantManagerRepo wraps the manager's per-entity repository; createMockDataSource
  // returns one fixed repo object for every such lookup, so stubbing that repo's find
  // drives the boundary read.
  const scopedRepo = (mockManager.getRepository as jest.Mock)() as { find: jest.Mock };
  scopedRepo.find.mockResolvedValue(rows);
  return {
    service: new BatchHarvestEligibilityService(mockDataSource),
    scopedRepo,
  };
}

describe('BatchHarvestEligibilityService', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const batchId = '22222222-2222-4222-8222-222222222222';

  it('returns eligible=true when no blocking events exist', async () => {
    const { service } = makeService([]);

    const result = await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(result.eligible).toBe(true);
    expect(result.blockingEvents).toEqual([]);
    expect(result.blockedUntil).toBeUndefined();
  });

  it('blocks harvest when an active event has earliestHarvestDate in the future', async () => {
    const earliest = new Date('2026-07-15');
    const { service } = makeService([
      {
        id: 'evt-1',
        title: 'Amoxicillin treatment',
        diseaseName: 'Columnaris',
        earliestHarvestDate: earliest,
        withdrawalPeriodDays: 14,
        status: HealthEventStatus.ACTIVE,
      },
    ]);

    const result = await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockedUntil).toEqual(earliest);
    expect(result.reason).toContain('1 active health event');
    expect(result.blockingEvents).toHaveLength(1);
    expect(result.blockingEvents[0]!.id).toBe('evt-1');
  });

  it('returns the LATEST earliestHarvestDate as blockedUntil when multiple events block', async () => {
    // Service orders DESC by earliestHarvestDate, so the first row is the
    // latest. The mock must return rows in the same order the real query
    // would (sorted DESC) to keep the test aligned with production.
    const later = new Date('2026-08-20');
    const earlier = new Date('2026-07-15');
    const { service } = makeService([
      {
        id: 'evt-late',
        title: 'Oxytetracycline treatment',
        diseaseName: undefined,
        earliestHarvestDate: later,
        withdrawalPeriodDays: 30,
        status: HealthEventStatus.ACTIVE,
      },
      {
        id: 'evt-early',
        title: 'Amoxicillin treatment',
        diseaseName: 'Columnaris',
        earliestHarvestDate: earlier,
        withdrawalPeriodDays: 14,
        status: HealthEventStatus.MONITORING,
      },
    ]);

    const result = await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockedUntil).toEqual(later);
    expect(result.blockingEvents).toHaveLength(2);
    expect(result.reason).toContain('2 active health event');
  });

  it('narrows the query to the correct tenant and batch', async () => {
    const { service, scopedRepo } = makeService([]);

    await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(scopedRepo.find).toHaveBeenCalledTimes(1);
    // tenantManagerRepo injects tenantId into the WHERE; batchId is set by the service.
    const calledWith = scopedRepo.find.mock.calls[0]![0] as {
      where: { tenantId: string; batchId: string; status?: unknown };
    };
    expect(calledWith.where.tenantId).toBe(tenantId);
    expect(calledWith.where.batchId).toBe(batchId);
    // Status filter must include ACTIVE and MONITORING; resolved/chronic/
    // cancelled events should NOT block.
    expect(calledWith.where.status).toBeDefined();
  });
});
