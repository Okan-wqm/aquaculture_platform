import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { FishHealthAiQueryResponder } from '../fish-health-ai-query.responder';
import { BatchHarvestEligibilityService } from '../../services/batch-harvest-eligibility.service';
import { GetHealthEventStatsQuery } from '../../queries/get-health-event-stats.query';
import { ListCriticalHealthEventsQuery } from '../../queries/list-critical-health-events.query';
import { ListHealthEventsQuery } from '../../queries/list-health-events.query';
import { ListLiceCountsQuery } from '../../queries/list-lice-counts.query';
import { ListOverdueFollowUpsQuery } from '../../queries/list-overdue-follow-ups.query';
import { ListTreatmentApplicationsQuery } from '../../queries/list-treatment-applications.query';
import { ListWelfareAssessmentsQuery } from '../../queries/list-welfare-assessments.query';
import { HealthEvent } from '../../entities/health-event.entity';
import { LiceCount } from '../../entities/lice-count.entity';
import { TreatmentApplication } from '../../entities/treatment-application.entity';
import { WelfareAssessment } from '../../entities/welfare-assessment.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const SITE = '44444444-4444-4444-8444-444444444444';

function healthEvent(overrides: Partial<HealthEvent> = {}): HealthEvent {
  return {
    id: 'he1',
    tenantId: TENANT,
    batchId: BATCH,
    tankId: TANK,
    title: 'Saprolegnia outbreak',
    description: 'clinical narrative',
    eventType: 'disease' as HealthEvent['eventType'],
    severity: 'critical' as HealthEvent['severity'],
    status: 'active' as HealthEvent['status'],
    diseaseCategory: 'fungal' as HealthEvent['diseaseCategory'],
    diseaseName: 'Saprolegnia',
    eventDate: new Date('2026-09-01'),
    isUnderTreatment: true,
    isQuarantined: false,
    labConfirmed: false,
    vetNotified: true,
    withdrawalPeriodDays: 12,
    earliestHarvestDate: new Date('2026-09-20'),
    followUpRequired: true,
    nextFollowUpDate: new Date('2026-09-10'),
    reportedBy: 'operator-user-id', // PII — must never cross the wire
    notes: 'operator note',
    attachments: ['https://bucket/photo.jpg'],
    vetConsultation: { vet: 'Dr. Doe' },
    ...overrides,
  } as HealthEvent;
}

function liceCount(overrides: Partial<LiceCount> = {}): LiceCount {
  return {
    id: 'lc1',
    tenantId: TENANT,
    siteId: SITE,
    tankId: TANK,
    batchId: BATCH,
    countDate: '2026-09-07',
    reportingYear: 2026,
    reportingWeek: 37,
    adultFemaleLice: 0.5,
    mobileLice: 1.25,
    attachedLice: 2,
    fishSampled: 20,
    seaTemperatureC: 13.5,
    countedBy: 'operator-user-id', // PII
    notes: 'operator note',
    ...overrides,
  } as LiceCount;
}

function treatment(overrides: Partial<TreatmentApplication> = {}): TreatmentApplication {
  return {
    id: 'ta1',
    tenantId: TENANT,
    siteId: SITE,
    tankId: TANK,
    batchId: BATCH,
    healthEventId: 'he1',
    category: 'medicinal' as TreatmentApplication['category'],
    method: 'BADEBEHANDLING',
    virkestoffType: 'AZAMETHIPHOS',
    styrkeVerdi: 100,
    styrkeEnhet: 'mg/kg',
    mengdeVerdi: 3.5,
    mengdeEnhet: 'kg',
    wholeSite: false,
    pensCount: 4,
    appliedAt: new Date('2026-09-01T08:00:00.000Z'),
    completedAt: null,
    veterinarianWorkerId: 'worker-uuid', // PII
    externalVetName: 'Dr. Doe', // PII
    beskrivelse: 'free text', // notes-like
    recordedBy: 'operator-user-id', // PII
    ...overrides,
  } as TreatmentApplication;
}

function welfare(overrides: Partial<WelfareAssessment> = {}): WelfareAssessment {
  return {
    id: 'wa1',
    tenantId: TENANT,
    siteId: SITE,
    tankId: TANK,
    batchId: BATCH,
    assessedAt: '2026-09-05',
    fishSampled: 20,
    gillScore: 1,
    finScore: 2,
    woundScore: 0,
    deformityScore: 0,
    assessedBy: 'operator-user-id', // PII
    notes: 'operator note',
    ...overrides,
  } as WelfareAssessment;
}

describe('FishHealthAiQueryResponder (PR-3 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let checkEligibility: jest.Mock;
  let responder: FishHealthAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    checkEligibility = jest.fn();
    responder = new FishHealthAiQueryResponder(
      { execute } as unknown as QueryBus,
      { checkEligibility } as unknown as BatchHarvestEligibilityService,
    );
  });

  // ------------------------------------------------------------------- FH_STATS
  it('FH_STATS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.stats({})).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(await responder.stats({ tenantId: 'nope' })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_STATS: happy path executes the tenant query and returns counters', async () => {
    execute.mockResolvedValue({
      total: 9,
      active: 4,
      critical: 2,
      underTreatment: 1,
      quarantined: 0,
      resolved: 5,
      byEventType: { disease: 6, mortality: 3 },
      bySeverity: { critical: 2, moderate: 7 },
    });

    const reply = await responder.stats({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(GetHealthEventStatsQuery));
    expect((execute.mock.calls[0][0] as GetHealthEventStatsQuery).tenantId).toBe(TENANT);
    expect(reply).toEqual({
      ok: true,
      data: {
        total: 9,
        active: 4,
        critical: 2,
        underTreatment: 1,
        quarantined: 0,
        resolved: 5,
        byEventType: { disease: 6, mortality: 3 },
        bySeverity: { critical: 2, moderate: 7 },
      },
    });
  });

  it('FH_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.stats({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------------------------ FH_EVENTS
  it('FH_EVENTS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, batchId: 'b1' },
      { tenantId: TENANT, severity: 'catastrophic' },
      { tenantId: TENANT, activeOnly: 'yes' },
      { tenantId: TENANT, limit: 0 },
    ]) {
      expect(await responder.events(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_EVENTS: happy path passes ONLY contract-supported filters and bounds the list', async () => {
    execute.mockResolvedValue({ items: [healthEvent()], total: 1 });

    const reply = await responder.events({
      tenantId: TENANT,
      batchId: BATCH,
      tankId: TANK,
      severity: 'critical',
      limit: 5,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListHealthEventsQuery));
    const query = execute.mock.calls[0][0] as ListHealthEventsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.filter).toMatchObject({
      batchId: BATCH,
      tankId: TANK,
      severity: 'critical',
      activeOnly: true,
      limit: 5,
    });
    // unsupported fields must not leak into the filter
    expect(Object.keys(query.filter ?? {})).not.toContain('searchText');
    expect(Object.keys(query.filter ?? {})).not.toContain('reportedBy');

    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain('operator-user-id');
    expect(serialized).not.toContain('reportedBy');
    expect(serialized).not.toContain('operator note');
    expect(serialized).not.toContain('photo.jpg');
    expect(serialized).not.toContain('Dr. Doe');
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [{ id: 'he1', earliestHarvestDate: '2026-09-20T00:00:00.000Z' }],
        truncated: false,
        total: 1,
      },
    });
  });

  it('FH_EVENTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.events({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ---------------------------------------------------------------- FH_CRITICAL
  it('FH_CRITICAL: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.critical({ tenantId: TENANT, limit: -1 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(await responder.critical(undefined)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_CRITICAL: happy path executes the query with a PII-free bounded list', async () => {
    execute.mockResolvedValue([healthEvent()]);

    const reply = await responder.critical({ tenantId: TENANT, limit: 20 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListCriticalHealthEventsQuery));
    expect((execute.mock.calls[0][0] as ListCriticalHealthEventsQuery).tenantId).toBe(TENANT);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(1);
      expect(reply.data.items[0]?.eventDate).toBe('2026-09-01T00:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('operator-user-id');
    }
  });

  it('FH_CRITICAL: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.critical({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // -------------------------------------------------------- FH_OVERDUE_FOLLOW_UPS
  it('FH_OVERDUE_FOLLOW_UPS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.overdueFollowUps({ tenantId: TENANT, limit: 51 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_OVERDUE_FOLLOW_UPS: happy path executes the query', async () => {
    execute.mockResolvedValue([healthEvent()]);

    const reply = await responder.overdueFollowUps({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(ListOverdueFollowUpsQuery));
    expect((execute.mock.calls[0][0] as ListOverdueFollowUpsQuery).tenantId).toBe(TENANT);
    expect(reply).toMatchObject({
      ok: true,
      data: { items: [{ followUpRequired: true, nextFollowUpDate: '2026-09-10T00:00:00.000Z' }] },
    });
  });

  it('FH_OVERDUE_FOLLOW_UPS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.overdueFollowUps({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // -------------------------------------------------------------- FH_LICE_COUNTS
  it('FH_LICE_COUNTS: invalid payload (bad uuid / week 54) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT, tankId: 'pen-3' },
      { tenantId: TENANT, reportingWeek: 54 },
      { tenantId: TENANT, reportingYear: 1999 },
    ]) {
      expect(await responder.liceCounts(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_LICE_COUNTS: happy path forwards the ISO week filters, PII-free', async () => {
    execute.mockResolvedValue([liceCount()]);

    const reply = await responder.liceCounts({
      tenantId: TENANT,
      siteId: SITE,
      reportingYear: 2026,
      reportingWeek: 37,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListLiceCountsQuery));
    const query = execute.mock.calls[0][0] as ListLiceCountsQuery;
    expect(query).toMatchObject({
      tenantId: TENANT,
      siteId: SITE,
      reportingYear: 2026,
      reportingWeek: 37,
    });
    expect(JSON.stringify(reply)).not.toContain('operator-user-id');
    expect(reply).toMatchObject({
      ok: true,
      data: { items: [{ adultFemaleLice: 0.5, mobileLice: 1.25, fishSampled: 20 }] },
    });
  });

  it('FH_LICE_COUNTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.liceCounts({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // -------------------------------------------------------------- FH_TREATMENTS
  it('FH_TREATMENTS: invalid payload (one-sided window / range > 366d) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT, fromDate: '2026-01-01' },
      { tenantId: TENANT, fromDate: '2024-01-01', toDate: '2026-01-01' },
      { tenantId: TENANT, siteId: 'site' },
    ]) {
      expect(await responder.treatments(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_TREATMENTS: happy path forwards site + window, drops vet fields', async () => {
    execute.mockResolvedValue([treatment()]);

    const reply = await responder.treatments({
      tenantId: TENANT,
      siteId: SITE,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListTreatmentApplicationsQuery));
    expect(execute.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      siteId: SITE,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    });

    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain('Dr. Doe');
    expect(serialized).not.toContain('worker-uuid');
    expect(serialized).not.toContain('free text');
    expect(serialized).not.toContain('operator-user-id');
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [{ appliedAt: '2026-09-01T08:00:00.000Z', method: 'BADEBEHANDLING' }],
      },
    });
  });

  it('FH_TREATMENTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.treatments({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ----------------------------------------------------------------- FH_WELFARE
  it('FH_WELFARE: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(
      await responder.welfare({ tenantId: TENANT, fromDate: '2026-01-01' }),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(await responder.welfare({ tenantId: TENANT, tankId: 7 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_WELFARE: happy path forwards filters, drops assessor PII', async () => {
    execute.mockResolvedValue([welfare()]);

    const reply = await responder.welfare({
      tenantId: TENANT,
      siteId: SITE,
      tankId: TANK,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListWelfareAssessmentsQuery));
    expect(execute.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      siteId: SITE,
      tankId: TANK,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    });
    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain('operator-user-id');
    expect(serialized).not.toContain('operator note');
    expect(reply).toMatchObject({
      ok: true,
      data: { items: [{ gillScore: 1, finScore: 2, fishSampled: 20 }] },
    });
  });

  it('FH_WELFARE: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.welfare({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ----------------------------------------------------- FH_HARVEST_ELIGIBILITY
  it('FH_HARVEST_ELIGIBILITY: invalid payload → INVALID_REQUEST, no eligibility call', async () => {
    for (const bad of [
      { tenantId: TENANT, batchId: BATCH }, // missing harvestDate
      { tenantId: TENANT, batchId: 'batch-7', harvestDate: '2026-10-01' },
      { tenantId: TENANT, batchId: BATCH, harvestDate: 'soon' },
    ]) {
      expect(await responder.harvestEligibility(bad)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
    expect(checkEligibility).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('FH_HARVEST_ELIGIBILITY: happy path checks the service and projects the decision', async () => {
    checkEligibility.mockResolvedValue({
      eligible: false,
      blockedUntil: new Date('2026-09-20'),
      reason: '1 active health event(s) with open withdrawal period.',
      blockingEvents: [
        {
          id: 'he1',
          title: 'Saprolegnia outbreak',
          diseaseName: 'Saprolegnia',
          earliestHarvestDate: new Date('2026-09-20'),
          withdrawalPeriodDays: 12,
          status: 'active',
        },
      ],
    });

    const reply = await responder.harvestEligibility({
      tenantId: TENANT,
      batchId: BATCH,
      harvestDate: '2026-09-10',
    });

    expect(checkEligibility).toHaveBeenCalledWith(TENANT, BATCH, new Date('2026-09-10'));
    expect(reply).toEqual({
      ok: true,
      data: {
        eligible: false,
        blockedUntil: '2026-09-20T00:00:00.000Z',
        reason: '1 active health event(s) with open withdrawal period.',
        blockingEvents: [
          {
            id: 'he1',
            title: 'Saprolegnia outbreak',
            diseaseName: 'Saprolegnia',
            earliestHarvestDate: '2026-09-20T00:00:00.000Z',
            withdrawalPeriodDays: 12,
            status: 'active',
          },
        ],
      },
    });
  });

  it('FH_HARVEST_ELIGIBILITY: service rejection → INTERNAL_ERROR', async () => {
    checkEligibility.mockRejectedValue(new Error('boom'));
    expect(
      await responder.harvestEligibility({
        tenantId: TENANT,
        batchId: BATCH,
        harvestDate: '2026-09-10',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
