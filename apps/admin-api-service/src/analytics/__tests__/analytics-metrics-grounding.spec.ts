/**
 * APA-132 — tenant metrics must be grounded in queried data, never invented.
 *
 * `getTenantMetrics()` returned `byRegion = { TR: total, EU: 0, US: 0, APAC: 0 }`
 * — every tenant assigned to Turkey by a literal. There is no region/country
 * column on the tenant SSoT (`auth.tenants`), so the platform never had that
 * data; the REQUIRED `byRegion` field on the contract left the compiler no
 * option but a constant, and the daily cron persisted it into the trend record.
 *
 * The field is now gone from the contract end-to-end. This gate has two jobs:
 *   1. the returned key set must equal the TenantMetrics contract exactly, so a
 *      re-added unsourceable field (byRegion or any successor) fails here;
 *   2. every metric must VARY with the underlying query rows — a hardcoded map
 *      is invariant to its input and cannot pass a two-row variance check.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-132
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AnalyticsSnapshot } from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';

/** Exactly the fields the TenantMetrics contract declares. */
const TENANT_METRIC_KEYS = [
  'total',
  'active',
  'inactive',
  'trial',
  'suspended',
  'newThisMonth',
  'churnedThisMonth',
  'churnRate',
  'growthRate',
  'byPlan',
].sort();

async function buildService(row: Record<string, unknown>): Promise<AnalyticsService> {
  const repo = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AnalyticsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: repo },
      { provide: getRepositoryToken(UserReadOnly), useValue: repo },
      { provide: getRepositoryToken(SubscriptionReadOnly), useValue: repo },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: repo },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([row]) } },
      { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn() } },
    ],
  }).compile();
  return module.get(AnalyticsService);
}

const ROW_A = {
  total: '10', active: '6', inactive: '2', trial: '1', suspended: '1',
  new_this_month: '3', churned_this_month: '1',
  starter: '4', professional: '3', enterprise: '2',
};
const ROW_B = {
  total: '200', active: '150', inactive: '20', trial: '20', suspended: '10',
  new_this_month: '40', churned_this_month: '5',
  starter: '80', professional: '70', enterprise: '50',
};

describe('AnalyticsService.getTenantMetrics grounding (APA-132)', () => {
  it('returns exactly the contract key set — no unsourceable field like byRegion', async () => {
    const service = await buildService(ROW_A);
    const metrics = await service.getTenantMetrics();

    expect(Object.keys(metrics).sort()).toEqual(TENANT_METRIC_KEYS);
    expect(Object.keys(metrics)).not.toContain('byRegion');
  });

  it('varies every metric with the queried rows — a hardcoded map cannot pass', async () => {
    const a = await service_a();
    const b = await service_b();

    // A constant (e.g. `{ TR: total, EU: 0, US: 0, APAC: 0 }`) would be
    // invariant to the query result for the zeroed keys; real aggregates move.
    expect(a.total).not.toBe(b.total);
    expect(a.active).not.toBe(b.active);
    expect(a.churnRate).not.toBe(b.churnRate);
    expect(a.growthRate).not.toBe(b.growthRate);
    expect(a.byPlan).not.toEqual(b.byPlan);

    async function service_a(): ReturnType<AnalyticsService['getTenantMetrics']> {
      return (await buildService(ROW_A)).getTenantMetrics();
    }
    async function service_b(): ReturnType<AnalyticsService['getTenantMetrics']> {
      return (await buildService(ROW_B)).getTenantMetrics();
    }
  });
});
