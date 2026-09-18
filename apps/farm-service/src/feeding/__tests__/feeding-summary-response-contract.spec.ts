import { CommandBus, QueryBus } from '@platform/cqrs';
import { collaborator } from '@aquaculture/testing';
import { DataSource } from 'typeorm';

import { FeedingResolver } from '../resolvers/feeding.resolver';
import { FeedingSummaryResult } from '../queries/get-feeding-summary.query';
import { GrowthSimulatorService } from '../services/growth-simulator.service';

/**
 * Feeding-summary read-back contract (ORPHAN-MEDIUM-270). The resolver returned
 * the flat handler Result unmapped, so every non-nullable @Field on
 * FeedingSummaryResponse (startDate/endDate, totalFeedGivenKg, totalFeedings,
 * byFeedType…) was absent → GraphQL "Cannot return null for non-nullable field"
 * and a dead feeding-summary tab. These cases pin that the resolver maps the
 * Result onto a fully-populated Response.
 */
describe('FeedingResolver.feedingSummary — response contract completeness', () => {
  const result: FeedingSummaryResult = {
    entityId: 'batch-1',
    entityType: 'batch',
    entityName: 'Batch 1',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-01-31'),
    totalFeedingsCount: 12,
    totalPlannedKg: 100,
    totalActualKg: 95,
    totalVarianceKg: -5,
    totalWasteKg: 2,
    totalFeedCost: 480,
    avgDailyFeedingKg: 3.2,
    avgVariancePercent: -5,
    avgFeedingDuration: 15,
    appetiteDistribution: { excellent: 5, good: 4, moderate: 2, poor: 1, none: 0 },
    feedTypeDistribution: [
      { feedId: 'feed-a', feedName: 'Feed A', totalKg: 60, percentage: 63.2, cost: 300 },
      { feedId: 'feed-b', feedName: 'Feed B', totalKg: 35, percentage: 36.8, cost: 180 },
    ],
    dailyTrend: [],
  };

  function resolverReturning(value: FeedingSummaryResult): FeedingResolver {
    // Ctor: (commandBus, queryBus, growthSimulator, dataSource). Only the query
    // bus is exercised on this path; the rest are EMPTY TYPED doubles, so a
    // resolver that starts reaching for one fails by name here instead of
    // silently working against an object that models nothing.
    return new FeedingResolver(
      collaborator<CommandBus>({}, 'CommandBus'),
      collaborator<QueryBus>({ execute: jest.fn().mockResolvedValue(value) }, 'QueryBus'),
      collaborator<GrowthSimulatorService>({}, 'GrowthSimulatorService'),
      collaborator<DataSource>({}, 'DataSource'),
    );
  }

  it('maps the handler Result onto a fully-populated FeedingSummaryResponse', async () => {
    const resolver = resolverReturning(result);

    const response = await resolver.feedingSummary('t1', 'batch', 'batch-1', undefined, undefined);

    // every non-nullable @Field is present + correctly renamed
    expect(response.startDate).toEqual(result.startDate);
    expect(response.endDate).toEqual(result.endDate);
    expect(response.totalFeedGivenKg).toBe(95); // totalActualKg
    expect(response.totalPlannedKg).toBe(100);
    expect(response.varianceKg).toBe(-5); // totalVarianceKg
    expect(response.variancePercent).toBe(-5); // avgVariancePercent
    expect(response.totalFeedings).toBe(12); // totalFeedingsCount
    expect(response.avgFeedingKg).toBe(3.2); // avgDailyFeedingKg
    expect(response.totalCost).toBe(480); // totalFeedCost
    expect(response.batchId).toBe('batch-1');
    // byFeedType carries the per-type cost the response requires
    expect(response.byFeedType).toHaveLength(2);
    expect(response.byFeedType[0]).toMatchObject({ feedId: 'feed-a', cost: 300 });

    // No non-nullable field is left undefined (the exact prior failure mode)
    const required: Array<keyof typeof response> = [
      'startDate', 'endDate', 'totalFeedGivenKg', 'totalPlannedKg', 'varianceKg',
      'variancePercent', 'totalFeedings', 'avgFeedingKg', 'totalCost', 'byFeedType',
    ];
    for (const key of required) {
      expect(response[key]).toBeDefined();
    }
  });

  it('sets batchId for a batch summary and leaves siteId/currency nullable', async () => {
    const resolver = resolverReturning({ ...result, entityType: 'tank', entityId: 'tank-9' });

    const response = await resolver.feedingSummary('t1', 'tank', 'tank-9', undefined, undefined);

    expect(response.batchId).toBeUndefined(); // not a batch
    expect(response.siteId).toBeUndefined(); // result carries no siteId
  });
});
