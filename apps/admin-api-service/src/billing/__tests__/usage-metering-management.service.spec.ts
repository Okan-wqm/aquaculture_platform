/**
 * APA-122 — getUsageSummary must NOT mask a failed read as a legitimately-empty
 * period. It was the lone silent-failure mask in the service: every other read
 * (getTenantUsageOverview, getAllTenantsUsage, getUsageTrends,
 * getTopTenantsByUsage) lets errors propagate, but getUsageSummary wrapped its
 * whole body in try/catch and returned fully-zeroed stats, so the controller
 * passed a 200 OK with an empty meterBreakdown straight to the dashboard —
 * indistinguishable from "this period genuinely had no usage".
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/billing-plans.md#APA-122
 */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UsageAggregationReadOnly } from '../entities/usage-aggregation-readonly.entity';
import { UsageMeteringManagementService } from '../services/usage-metering-management.service';

describe('UsageMeteringManagementService.getUsageSummary (APA-122)', () => {
  async function buildService(
    createQueryBuilder: jest.Mock,
  ): Promise<UsageMeteringManagementService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageMeteringManagementService,
        {
          provide: getRepositoryToken(UsageAggregationReadOnly),
          useValue: { createQueryBuilder },
        },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();
    return moduleRef.get(UsageMeteringManagementService);
  }

  it('propagates a read failure instead of returning zeroed stats as a success', async () => {
    const boom = new Error('relation "usage_aggregations" does not exist');
    const service = await buildService(
      jest.fn(() => {
        throw boom;
      }),
    );

    await expect(service.getUsageSummary()).rejects.toThrow(
      'relation "usage_aggregations" does not exist',
    );
  });

  it('still returns a real summary when the read succeeds', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const service = await buildService(jest.fn(() => qb));

    const summary = await service.getUsageSummary();

    expect(summary.totalTenants).toBe(0);
    expect(summary.totalEvents).toBe(0);
    expect(summary.meterBreakdown).toEqual([]);
  });
});
