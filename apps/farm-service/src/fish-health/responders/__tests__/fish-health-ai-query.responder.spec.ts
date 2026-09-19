import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { HealthSeverity, type HealthEvent } from '../../entities/health-event.entity';
import { GetHealthEventStatsQuery } from '../../queries/get-health-event-stats.query';
import { ListHealthEventsQuery } from '../../queries/list-health-events.query';
import { ListLiceCountsQuery } from '../../queries/list-lice-counts.query';
import type { BatchHarvestEligibilityService } from '../../services/batch-harvest-eligibility.service';
import { FishHealthAiQueryResponder } from '../fish-health-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';

function healthEvent(overrides: Partial<HealthEvent> = {}): HealthEvent {
  return {
    id: EVENT,
    tenantId: TENANT,
    batchId: BATCH,
    title: 'Gill lesions in pen 3',
    eventType: 'symptom_observed',
    eventDate: new Date('2026-09-15T00:00:00Z'),
    severity: 'severe',
    status: 'active',
    diseaseCategory: 'bacterial',
    diseaseName: 'Columnaris',
    isUnderTreatment: true,
    isQuarantined: false,
    withdrawalPeriodDays: 21,
    earliestHarvestDate: new Date('2026-10-06T00:00:00Z'),
    followUpRequired: true,
    nextFollowUpDate: new Date('2026-09-20T00:00:00Z'),
    affectedPopulation: { mortalityCount: 40 },
    vetConsultation: { vetName: 'Dr. Secret', vetLicense: 'LIC-1', notes: 'private' },
    labConfirmed: false,
    vetNotified: true,
    ...overrides,
  } as HealthEvent;
}

describe('FishHealthAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let checkEligibility: jest.Mock;
  let responder: FishHealthAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    checkEligibility = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    const eligibility: Pick<BatchHarvestEligibilityService, 'checkEligibility'> = {
      checkEligibility,
    };
    responder = new FishHealthAiQueryResponder(
      queryBus as QueryBus,
      eligibility as BatchHarvestEligibilityService,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe(FARM_AI_QUERY_SUBJECTS.FH_STATS, () => {
    it('rejects extra keys (a request carrying anything beyond the contract is refused)', async () => {
      const reply = await responder.getStats({ tenantId: TENANT, siteId: BATCH });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('projects the stats verbatim', async () => {
      execute.mockResolvedValue({
        total: 5,
        active: 2,
        critical: 1,
        underTreatment: 1,
        quarantined: 0,
        resolved: 3,
        byEventType: { symptom_observed: 2 },
        bySeverity: { severe: 1 },
      });
      const reply = await responder.getStats({ tenantId: TENANT });
      expect(execute).toHaveBeenCalledWith(expect.any(GetHealthEventStatsQuery));
      expect(reply).toEqual({
        ok: true,
        data: {
          total: 5,
          active: 2,
          critical: 1,
          underTreatment: 1,
          quarantined: 0,
          resolved: 3,
          byEventType: { symptom_observed: 2 },
          bySeverity: { severe: 1 },
        },
      });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.FH_EVENTS, () => {
    it('builds the domain filter from the request, bounds the page and strips every vet / note field', async () => {
      execute.mockResolvedValue({ items: [healthEvent()], total: 1, page: 1, limit: 10 });

      const reply = await responder.listEvents({
        tenantId: TENANT,
        batchId: BATCH,
        activeOnly: true,
        severity: 'severe',
        limit: 10,
      });

      expect(execute).toHaveBeenCalledWith(expect.any(ListHealthEventsQuery));
      const query = execute.mock.calls[0][0] as ListHealthEventsQuery;
      expect(query.tenantId).toBe(TENANT);
      expect(query.filter).toMatchObject({
        batchId: BATCH,
        activeOnly: true,
        severity: HealthSeverity.SEVERE,
        limit: 10,
        offset: 0,
      });
      expect(reply).toMatchObject({
        ok: true,
        data: {
          total: 1,
          truncated: false,
          items: [
            {
              id: EVENT,
              severity: 'severe',
              diseaseName: 'Columnaris',
              mortalityCount: 40,
              withdrawalPeriodDays: 21,
              earliestHarvestDate: '2026-10-06T00:00:00.000Z',
              nextFollowUpDate: '2026-09-20T00:00:00.000Z',
            },
          ],
        },
      });
      const wire = JSON.stringify(reply);
      for (const secret of ['Dr. Secret', 'LIC-1', 'private', 'vetConsultation']) {
        expect(wire).not.toContain(secret);
      }
    });

    it('maps a rejected query to INTERNAL_ERROR', async () => {
      execute.mockRejectedValue(new Error('boom'));
      const reply = await responder.listEvents({ tenantId: TENANT, activeOnly: true, limit: 5 });
      expect(reply).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS, () => {
    it('forwards the optional filters in the query constructor order', async () => {
      execute.mockResolvedValue([]);
      await responder.listLiceCounts({
        tenantId: TENANT,
        tankId: BATCH,
        reportingYear: 2026,
        reportingWeek: 37,
        limit: 5,
      });
      const query = execute.mock.calls[0][0] as ListLiceCountsQuery;
      expect(query).toMatchObject({
        tenantId: TENANT,
        siteId: undefined,
        tankId: BATCH,
        reportingYear: 2026,
        reportingWeek: 37,
      });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY, () => {
    it('asks the eligibility service (tenant-pinned inside) and echoes batch + date', async () => {
      checkEligibility.mockResolvedValue({
        eligible: false,
        blockedUntil: new Date('2026-10-06T00:00:00Z'),
        reason: '1 active treatment window',
        blockingEvents: [
          {
            id: EVENT,
            title: 'Gill lesions in pen 3',
            diseaseName: 'Columnaris',
            earliestHarvestDate: new Date('2026-10-06T00:00:00Z'),
            withdrawalPeriodDays: 21,
            status: 'active',
          },
        ],
      });

      const reply = await responder.checkHarvestEligibility({
        tenantId: TENANT,
        batchId: BATCH,
        harvestDate: '2026-10-01',
      });

      expect(checkEligibility).toHaveBeenCalledWith(TENANT, BATCH, new Date('2026-10-01'));
      expect(reply).toEqual({
        ok: true,
        data: {
          batchId: BATCH,
          harvestDate: '2026-10-01',
          eligible: false,
          blockedUntil: '2026-10-06T00:00:00.000Z',
          reason: '1 active treatment window',
          blockingEvents: [
            {
              id: EVENT,
              title: 'Gill lesions in pen 3',
              diseaseName: 'Columnaris',
              earliestHarvestDate: '2026-10-06T00:00:00.000Z',
              withdrawalPeriodDays: 21,
              status: 'active',
            },
          ],
        },
      });
    });

    it('rejects a malformed date', async () => {
      const reply = await responder.checkHarvestEligibility({
        tenantId: TENANT,
        batchId: BATCH,
        harvestDate: 'next tuesday',
      });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect(checkEligibility).not.toHaveBeenCalled();
    });
  });
});
