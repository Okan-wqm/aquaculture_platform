/**
 * BatchHarvestEligibilityService Unit Tests
 *
 * Covers the invariant: a batch cannot be harvested while any active
 * HealthEvent has an earliestHarvestDate past the requested harvest
 * date. Drives the compliance gate in createHarvestRecord (see
 * docs/illustrator/ — Girdi 14h).
 *
 * Architecture: direct instantiation with a repository mock —
 * mirroring the record-mortality.handler.spec.ts pattern.
 */
import { Repository } from 'typeorm';
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

function makeRepoMock(rows: HealthEventRow[]): Repository<HealthEvent> {
  return {
    find: jest.fn().mockResolvedValue(rows),
  } as unknown as Repository<HealthEvent>;
}

describe('BatchHarvestEligibilityService', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const batchId = '22222222-2222-4222-8222-222222222222';

  it('returns eligible=true when no blocking events exist', async () => {
    const repo = makeRepoMock([]);
    const service = new BatchHarvestEligibilityService(repo);

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
    const repo = makeRepoMock([
      {
        id: 'evt-1',
        title: 'Amoxicillin treatment',
        diseaseName: 'Columnaris',
        earliestHarvestDate: earliest,
        withdrawalPeriodDays: 14,
        status: HealthEventStatus.ACTIVE,
      },
    ]);
    const service = new BatchHarvestEligibilityService(repo);

    const result = await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockedUntil).toEqual(earliest);
    expect(result.reason).toContain('1 active health event');
    expect(result.blockingEvents).toHaveLength(1);
    expect(result.blockingEvents[0].id).toBe('evt-1');
  });

  it('returns the LATEST earliestHarvestDate as blockedUntil when multiple events block', async () => {
    // Service orders DESC by earliestHarvestDate, so the first row is the
    // latest. The repo mock must return rows in the same order the real
    // query would (sorted DESC) to keep the test aligned with production.
    const later = new Date('2026-08-20');
    const earlier = new Date('2026-07-15');
    const repo = makeRepoMock([
      {
        id: 'evt-late',
        title: 'Oxytetracycline treatment',
        diseaseName: null,
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
    const service = new BatchHarvestEligibilityService(repo);

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
    const repo = makeRepoMock([]);
    const service = new BatchHarvestEligibilityService(repo);

    await service.checkEligibility(
      tenantId,
      batchId,
      new Date('2026-06-01'),
    );

    expect(repo.find).toHaveBeenCalledTimes(1);
    const calledWith = (repo.find as jest.Mock).mock.calls[0][0];
    expect(calledWith.where.tenantId).toBe(tenantId);
    expect(calledWith.where.batchId).toBe(batchId);
    // Status filter must include ACTIVE and MONITORING; resolved/chronic/
    // cancelled events should NOT block.
    expect(calledWith.where.status).toBeDefined();
  });
});
