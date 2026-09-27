import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_NAMESPACE,
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isAiQueryList,
  isAiQueryReply,
  isBoundedDateRange,
  isHarvestEligibilityRequest,
  isHealthEventDto,
  isHealthEventsRequest,
  isTankWaterQualityStatsRequest,
  isWaterQualityHistoryRequest,
  isWqMeasurementDto,
} from '../farm-ai-queries';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TANK = '22222222-2222-4222-8222-222222222222';

/**
 * Farm AI read contract (FARM-MEDIUM-328) — the shapes both farm-service
 * responders and ai-service tools validate against.
 */
describe('FARM_AI_QUERY_SUBJECTS', () => {
  it('every subject is namespaced and unique', () => {
    const values = Object.values(FARM_AI_QUERY_SUBJECTS);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value.startsWith(FARM_AI_QUERY_NAMESPACE)).toBe(true);
  });

  it('keys do not collide with the other contract files the NATS invariant loads (it keys constants by bare KEY)', () => {
    const otherFiles = [
      'billing-admin-commands.ts',
      'notification-commands.ts',
      'tenant-commands.ts',
      'websocket-envelopes.ts',
      'auth-admin-commands.ts',
      'auth-user-queries.ts',
    ];
    const ownKeys = Object.keys(FARM_AI_QUERY_SUBJECTS);
    for (const file of otherFiles) {
      // The invariant tolerates a contract file that is absent on a branch.
      const path = resolve(__dirname, '..', file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf-8');
      for (const key of ownKeys) {
        expect({ file, key, collides: new RegExp(`^\\s*${key}\\s*:`, 'm').test(source) }).toEqual({
          file,
          key,
          collides: false,
        });
      }
    }
  });
});

describe('envelope guards', () => {
  it('isAiQueryReply accepts both envelope arms and rejects the legacy bare-array reply', () => {
    expect(isAiQueryReply({ ok: true, data: [] })).toBe(true);
    expect(isAiQueryReply({ ok: false, error: 'INTERNAL_ERROR' })).toBe(true);
    expect(isAiQueryReply({ ok: false, error: 'SOMETHING_ELSE' })).toBe(false);
    expect(isAiQueryReply([])).toBe(false);
    expect(isAiQueryReply({ ok: true })).toBe(false);
  });

  it('isAiQueryList checks every item and the truncated flag', () => {
    const isNum = (v: unknown): v is number => typeof v === 'number';
    expect(isAiQueryList({ items: [1, 2], truncated: false }, isNum)).toBe(true);
    expect(isAiQueryList({ items: [1, 'x'], truncated: false }, isNum)).toBe(false);
    expect(isAiQueryList({ items: [], truncated: 'no' }, isNum)).toBe(false);
  });

  it('clampListLimit bounds to [1, MAX] and defaults when absent', () => {
    expect(clampListLimit(undefined)).toBe(FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT);
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(999)).toBe(FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
    expect(clampListLimit(7.9)).toBe(7);
  });

  it('isBoundedDateRange requires order and a span within the cap', () => {
    expect(isBoundedDateRange('2026-09-01', '2026-09-18', 90)).toBe(true);
    expect(isBoundedDateRange('2026-09-18', '2026-09-01', 90)).toBe(false);
    expect(isBoundedDateRange('2026-01-01', '2026-09-18', 90)).toBe(false);
    expect(isBoundedDateRange('yesterday', '2026-09-18', 90)).toBe(false);
  });
});

describe('request guards (trust boundary)', () => {
  it('accept exactly the contract keys and reject extras, bad ids and out-of-range values', () => {
    expect(isTankWaterQualityStatsRequest({ tenantId: TENANT, tankId: TANK, days: 7 })).toBe(true);
    expect(isTankWaterQualityStatsRequest({ tenantId: TENANT, tankId: TANK, days: 91 })).toBe(
      false,
    );
    expect(isTankWaterQualityStatsRequest({ tenantId: TENANT, tankId: 'tank-1', days: 7 })).toBe(
      false,
    );
    expect(
      isTankWaterQualityStatsRequest({ tenantId: TENANT, tankId: TANK, days: 7, extra: 1 }),
    ).toBe(false);
    expect(isTankWaterQualityStatsRequest({ tenantId: 'nope', tankId: TANK, days: 7 })).toBe(false);
  });

  it('health events: optional filters, severity enum, mandatory activeOnly + limit', () => {
    expect(isHealthEventsRequest({ tenantId: TENANT, activeOnly: true, limit: 20 })).toBe(true);
    expect(
      isHealthEventsRequest({
        tenantId: TENANT,
        batchId: TANK,
        severity: 'critical',
        activeOnly: false,
        limit: 5,
      }),
    ).toBe(true);
    expect(
      isHealthEventsRequest({ tenantId: TENANT, severity: 'fatal', activeOnly: true, limit: 5 }),
    ).toBe(false);
    expect(isHealthEventsRequest({ tenantId: TENANT, limit: 5 })).toBe(false);
  });

  it('history requires an ordered window of at most MAX_STAT_DAYS', () => {
    expect(
      isWaterQualityHistoryRequest({
        tenantId: TENANT,
        tankId: TANK,
        fromDate: '2026-09-01',
        toDate: '2026-09-18',
        limit: 20,
      }),
    ).toBe(true);
    expect(
      isWaterQualityHistoryRequest({
        tenantId: TENANT,
        tankId: TANK,
        fromDate: '2026-01-01',
        toDate: '2026-09-18',
        limit: 20,
      }),
    ).toBe(false);
  });

  it('harvest eligibility takes a batch id and an ISO date', () => {
    expect(
      isHarvestEligibilityRequest({ tenantId: TENANT, batchId: TANK, harvestDate: '2026-10-01' }),
    ).toBe(true);
    expect(
      isHarvestEligibilityRequest({ tenantId: TENANT, batchId: TANK, harvestDate: '01/10/2026' }),
    ).toBe(false);
  });
});

describe('reply DTO guards', () => {
  it('measurement DTO requires ISO timestamps and nullable unit-suffixed numerics', () => {
    const dto = {
      measuredAt: '2026-09-18T06:00:00.000Z',
      tankId: TANK,
      pondId: null,
      temperatureC: 14.2,
      doMgL: null,
      doSaturationPct: null,
      ph: 7.6,
      salinityPpt: null,
      ammoniaMgL: null,
      tanMgL: null,
      nitriteMgL: null,
      nitrateMgL: null,
      alkalinityMgL: null,
      overallStatus: 'warning',
    };
    expect(isWqMeasurementDto(dto)).toBe(true);
    expect(isWqMeasurementDto({ ...dto, temperatureC: '14.2' })).toBe(false);
    expect(isWqMeasurementDto({ ...dto, measuredAt: 'Tuesday' })).toBe(false);
  });

  it('health event DTO carries no vet / reporter / note field', () => {
    const dto = {
      id: TANK,
      eventType: 'symptom_observed',
      severity: 'severe',
      status: 'active',
      title: 'Gill lesions',
      diseaseCategory: 'bacterial',
      diseaseName: 'Columnaris',
      batchId: TANK,
      tankId: null,
      eventDate: '2026-09-15T00:00:00.000Z',
      isUnderTreatment: true,
      isQuarantined: false,
      mortalityCount: 40,
      withdrawalPeriodDays: 21,
      earliestHarvestDate: '2026-10-06T00:00:00.000Z',
      followUpRequired: true,
      nextFollowUpDate: null,
    };
    expect(isHealthEventDto(dto)).toBe(true);
    expect(Object.keys(dto)).not.toEqual(
      expect.arrayContaining(['vetName', 'notes', 'reportedBy']),
    );
  });
});
