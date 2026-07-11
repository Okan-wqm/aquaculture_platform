/**
 * Immediate-report (varsling) submission tests — resolver → service → outbox.
 *
 * Locks the fix for fe-immediate-reports: welfare / escape / disease reports
 * now have a REAL submission path. Each resolver mutation delegates to
 * RegulatoryVarslingService, which enqueues a domain event through the
 * transactional outbox (committed atomically). The proven SeaLice/Smolt path
 * has no REST endpoint for these three — they are dispatched as urgent email
 * by notification-service — so the contract under test is:
 *   - success  → outbox.enqueue called, transaction committed,
 *                ReportSubmissionResult.success === true, referanse = eventId
 *   - failure  → outbox.enqueue throws → transaction rolled back,
 *                success === false, feilmelding surfaced (NEVER fake-success)
 */
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent } from '@platform/event-contracts';
import { createMockDataSource } from '@aquaculture/testing';
import { RegulatoryVarslingService } from '../services/regulatory-varsling.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import type { AuditLogService } from '../../database/services/audit-log.service';
import type { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { SlaughterFacilityService } from '../services/slaughter-facility.service';
import { MattilsynetSchemaValidatorService } from '../services/mattilsynet-schema-validator.service';
import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { RegulatoryResolver } from '../regulatory.resolver';
import { MattilsynetApiService } from '../mattilsynet-api.service';
import { MaskinportenService } from '../maskinporten.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import {
  SubmitWelfareEventInput,
  SubmitEscapeReportInput,
  SubmitDiseaseOutbreakInput,
  WelfareEventTypeInput,
  WelfareSeverityInput,
  DiseaseCategoryInput,
  DiseaseConfirmationInput,
} from '../dto/regulatory-varsling-inputs.dto';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER_ID = 'user-001';

interface MutationContext {
  req: { user: { tenantId: string; sub: string } };
}

function ctx(): MutationContext {
  return { req: { user: { tenantId: TENANT_ID, sub: USER_ID } } };
}

const baseInput = {
  klientReferanse: 'ref-123',
  organisasjonsnummer: '987654321',
  lokalitetsnummer: 12345,
  siteId: 'site-1',
  siteName: 'North Site',
  kontaktperson: { navn: 'Ola Nordmann', epost: 'ola@farm.no', telefonnummer: '+4798989898' },
  detectedAt: '2026-06-14T08:00:00.000Z',
  reportedBy: 'Ola Nordmann',
};

const welfareInput: SubmitWelfareEventInput = {
  ...baseInput,
  welfareEventType: WelfareEventTypeInput.MORTALITY_THRESHOLD,
  severity: WelfareSeverityInput.CRITICAL,
  mortalityRate: 12.5,
  mortalityPeriod: '3_day',
  description: 'Elevated mortality',
  immediateActions: ['Isolated cage 4'],
};

const escapeInput: SubmitEscapeReportInput = {
  ...baseInput,
  estimatedCount: 5000,
  species: 'Atlantic Salmon',
  avgWeightG: 3500,
  totalBiomassKg: 17500,
  cause: 'storm_damage',
  affectedUnits: ['Cage 3'],
  recoveryOngoing: true,
};

const diseaseInput: SubmitDiseaseOutbreakInput = {
  ...baseInput,
  diseaseCategory: DiseaseCategoryInput.C,
  diseaseName: 'Pancreas Disease',
  confirmation: DiseaseConfirmationInput.CONFIRMED,
  affectedCount: 2000,
  affectedPercentage: 15,
  clinicalSigns: ['lethargy'],
  veterinarianNotified: true,
  veterinarianName: 'Dr Vet',
};

describe('RegulatoryResolver — immediate varsling reports', () => {
  let resolver: RegulatoryResolver;
  let outboxEnqueue: jest.Mock;
  let mocks: ReturnType<typeof createMockDataSource>;

  beforeEach(() => {
    mocks = createMockDataSource();
    outboxEnqueue = jest.fn().mockResolvedValue(undefined);
    const outbox: Pick<OutboxPublisher, 'enqueue'> = { enqueue: outboxEnqueue };
    const reportStore = new RegulatoryReportStoreService(
      mocks.mockDataSource,
      {
        logWithManager: jest.fn().mockResolvedValue(undefined),
      } as Partial<AuditLogService> as AuditLogService,
      {
        incRegulatorySubmission: jest.fn(),
      } as Partial<FarmDomainMetricsService> as FarmDomainMetricsService,
    );
    const service = new RegulatoryVarslingService(
      mocks.mockDataSource,
      outbox as OutboxPublisher,
      reportStore,
    );

    // The three settings/API collaborators are unused by the varsling
    // mutations; empty stubs keep the resolver constructable without them.
    const mattilsynet = {} as MattilsynetApiService;
    const maskinporten = {} as MaskinportenService;
    const settings = {} as RegulatorySettingsService;
    // The submission service is unused by the varsling mutations (they route
    // through RegulatoryVarslingService); an empty stub keeps the resolver
    // constructable without it.
    const submissionService = {} as RegulatorySubmissionService;
    // The slaughter-facility service is unused by the varsling mutations; an
    // empty stub keeps the resolver constructable without it.
    const slaughterFacilityService = {} as SlaughterFacilityService;
    resolver = new RegulatoryResolver(
      mattilsynet,
      maskinporten,
      settings,
      service,
      new MattilsynetSchemaValidatorService(),
      submissionService,
      slaughterFacilityService,
    );
  });

  describe('submitWelfareEvent', () => {
    it('enqueues a WelfareEventReported event and returns success', async () => {
      const result = await resolver.submitWelfareEvent(welfareInput, ctx());

      expect(result.success).toBe(true);
      expect(result.klientReferanse).toBe('ref-123');
      expect(result.referanse).toBeDefined();
      expect(mocks.mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();

      const [event] = outboxEnqueue.mock.calls[0] as [BaseEvent];
      expect(event.eventType).toBe('WelfareEventReported');
      expect(event.tenantId).toBe(TENANT_ID);
      expect(event.userId).toBe(USER_ID);

      // FARM-HIGH-125: the submission record persists atomically with the
      // outbox enqueue — the QUEUED row is saved through the SAME manager.
      expect(mocks.mockManager.save).toHaveBeenCalledWith(
        RegulatoryReport,
        expect.objectContaining({
          reportType: 'WELFARE_EVENT',
          klientReferanse: 'ref-123',
          status: 'QUEUED',
        }),
      );
    });

    it('rolls back and surfaces the error on outbox failure (no fake-success)', async () => {
      outboxEnqueue.mockRejectedValueOnce(new Error('outbox down'));

      const result = await resolver.submitWelfareEvent(welfareInput, ctx());

      expect(result.success).toBe(false);
      expect(result.feilmelding).toBe('outbox down');
      expect(mocks.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('submitEscapeReport', () => {
    it('enqueues an EscapeReported event and returns success', async () => {
      const result = await resolver.submitEscapeReport(escapeInput, ctx());

      expect(result.success).toBe(true);
      const [event] = outboxEnqueue.mock.calls[0] as [BaseEvent];
      expect(event.eventType).toBe('EscapeReported');
      expect(mocks.mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back and surfaces the error on outbox failure', async () => {
      outboxEnqueue.mockRejectedValueOnce(new Error('nats unavailable'));

      const result = await resolver.submitEscapeReport(escapeInput, ctx());

      expect(result.success).toBe(false);
      expect(result.feilmelding).toBe('nats unavailable');
      expect(mocks.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('submitDiseaseOutbreak', () => {
    it('enqueues a DiseaseOutbreakReported event and returns success', async () => {
      const result = await resolver.submitDiseaseOutbreak(diseaseInput, ctx());

      expect(result.success).toBe(true);
      const [event] = outboxEnqueue.mock.calls[0] as [BaseEvent];
      expect(event.eventType).toBe('DiseaseOutbreakReported');
      expect(mocks.mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back and surfaces the error on outbox failure', async () => {
      outboxEnqueue.mockRejectedValueOnce(new Error('db error'));

      const result = await resolver.submitDiseaseOutbreak(diseaseInput, ctx());

      expect(result.success).toBe(false);
      expect(result.feilmelding).toBe('db error');
      expect(mocks.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
