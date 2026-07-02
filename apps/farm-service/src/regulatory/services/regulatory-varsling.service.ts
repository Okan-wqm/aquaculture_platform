/**
 * Regulatory Varsling Service
 *
 * The submission path for the THREE legally-immediate Mattilsynet reports
 * (welfare / escape / disease). Unlike the lakselus/settefisk/slakt reports
 * — which POST to the Mattilsynet `innrapportering-api` REST endpoints via
 * MattilsynetApiService — these "varsling" reports have NO REST endpoint.
 * The regulation routes them to varsling.akva@mattilsynet.no (escapes also to
 * Fiskeridirektoratet) as urgent email notifications.
 *
 * Rather than fabricate a non-existent REST URL (which would compile but 404
 * on every submit), this service publishes a domain event through the
 * transactional outbox. notification-service consumes the event and dispatches
 * the urgent email using its existing RegulatoryReportEmailData templates.
 *
 * WHY the outbox (not a direct email call) — farm-service does not own SMTP,
 * and a synchronous cross-service HTTP call would couple the user-facing
 * submit to notification-service availability. The outbox guarantees
 * at-least-once delivery: the event is committed atomically and the worker
 * delivers it even if NATS / notification-service is briefly unavailable —
 * exactly the durability a legally-immediate report demands.
 *
 * @module Regulatory/Services/Varsling
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  createBaseEvent,
  WelfareEventReportedEvent,
  EscapeReportedEvent,
  DiseaseOutbreakReportedEvent,
} from '@platform/event-contracts';
import {
  SubmitWelfareEventInput,
  SubmitEscapeReportInput,
  SubmitDiseaseOutbreakInput,
} from '../dto/regulatory-varsling-inputs.dto';
import { ReportSubmissionResult } from '../dto/regulatory-inputs.dto';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import { RegulatoryReportStoreService } from './regulatory-report-store.service';

@Injectable()
export class RegulatoryVarslingService {
  private readonly logger = new Logger(RegulatoryVarslingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly reportStore: RegulatoryReportStoreService,
  ) {}

  /**
   * Submit a welfare event report (varsling).
   * Enqueues a `WelfareEventReported` event for notification-service to email.
   */
  async submitWelfareEvent(
    tenantId: string,
    userId: string,
    input: SubmitWelfareEventInput,
  ): Promise<ReportSubmissionResult> {
    const event: WelfareEventReportedEvent = {
      ...createBaseEvent<WelfareEventReportedEvent>('WelfareEventReported', tenantId, {
        userId,
        aggregateId: input.siteId,
        aggregateType: 'WelfareEventReport',
        correlationId: input.klientReferanse,
      }),
      eventType: 'WelfareEventReported',
      klientReferanse: input.klientReferanse,
      organisasjonsnummer: input.organisasjonsnummer,
      lokalitetsnummer: input.lokalitetsnummer,
      siteId: input.siteId,
      siteName: input.siteName,
      siteCode: input.siteCode,
      kontaktperson: {
        navn: input.kontaktperson.navn,
        epost: input.kontaktperson.epost,
        telefonnummer: input.kontaktperson.telefonnummer,
      },
      siteManagerEmail: input.siteManagerEmail,
      detectedAt: input.detectedAt,
      reportedBy: input.reportedBy,
      welfareEventType: input.welfareEventType,
      severity: input.severity,
      mortalityRate: input.mortalityRate,
      mortalityPeriod: input.mortalityPeriod,
      affectedBatches: input.affectedBatches,
      description: input.description,
      immediateActions: input.immediateActions,
    };

    return this.enqueue(tenantId, userId, RegulatoryReportType.WELFARE_EVENT, input, event, 'Welfare Event');
  }

  /**
   * Submit a fish escape report (varsling).
   * Enqueues an `EscapeReported` event for notification-service to email.
   */
  async submitEscapeReport(
    tenantId: string,
    userId: string,
    input: SubmitEscapeReportInput,
  ): Promise<ReportSubmissionResult> {
    const event: EscapeReportedEvent = {
      ...createBaseEvent<EscapeReportedEvent>('EscapeReported', tenantId, {
        userId,
        aggregateId: input.siteId,
        aggregateType: 'EscapeReport',
        correlationId: input.klientReferanse,
      }),
      eventType: 'EscapeReported',
      klientReferanse: input.klientReferanse,
      organisasjonsnummer: input.organisasjonsnummer,
      lokalitetsnummer: input.lokalitetsnummer,
      siteId: input.siteId,
      siteName: input.siteName,
      siteCode: input.siteCode,
      kontaktperson: {
        navn: input.kontaktperson.navn,
        epost: input.kontaktperson.epost,
        telefonnummer: input.kontaktperson.telefonnummer,
      },
      siteManagerEmail: input.siteManagerEmail,
      detectedAt: input.detectedAt,
      reportedBy: input.reportedBy,
      estimatedCount: input.estimatedCount,
      species: input.species,
      avgWeightG: input.avgWeightG,
      totalBiomassKg: input.totalBiomassKg,
      cause: input.cause,
      affectedUnits: input.affectedUnits,
      recoveryOngoing: input.recoveryOngoing,
    };

    return this.enqueue(tenantId, userId, RegulatoryReportType.ESCAPE, input, event, 'Escape Report');
  }

  /**
   * Submit a notifiable disease outbreak report (varsling).
   * Enqueues a `DiseaseOutbreakReported` event for notification-service to email.
   */
  async submitDiseaseOutbreak(
    tenantId: string,
    userId: string,
    input: SubmitDiseaseOutbreakInput,
  ): Promise<ReportSubmissionResult> {
    const event: DiseaseOutbreakReportedEvent = {
      ...createBaseEvent<DiseaseOutbreakReportedEvent>('DiseaseOutbreakReported', tenantId, {
        userId,
        aggregateId: input.siteId,
        aggregateType: 'DiseaseOutbreakReport',
        correlationId: input.klientReferanse,
      }),
      eventType: 'DiseaseOutbreakReported',
      klientReferanse: input.klientReferanse,
      organisasjonsnummer: input.organisasjonsnummer,
      lokalitetsnummer: input.lokalitetsnummer,
      siteId: input.siteId,
      siteName: input.siteName,
      siteCode: input.siteCode,
      kontaktperson: {
        navn: input.kontaktperson.navn,
        epost: input.kontaktperson.epost,
        telefonnummer: input.kontaktperson.telefonnummer,
      },
      siteManagerEmail: input.siteManagerEmail,
      detectedAt: input.detectedAt,
      reportedBy: input.reportedBy,
      diseaseCategory: input.diseaseCategory,
      diseaseName: input.diseaseName,
      confirmation: input.confirmation,
      affectedCount: input.affectedCount,
      affectedPercentage: input.affectedPercentage,
      clinicalSigns: input.clinicalSigns,
      veterinarianNotified: input.veterinarianNotified,
      veterinarianName: input.veterinarianName,
    };

    return this.enqueue(tenantId, userId, RegulatoryReportType.DISEASE_OUTBREAK, input, event, 'Disease Outbreak');
  }

  /**
   * Enqueue the varsling event and persist the submission record in ONE
   * tenant-pinned transaction (FARM-HIGH-112): the `regulatory_reports`
   * row (status QUEUED) exists iff the outbox event that carries the
   * urgent e-mail is committed. runInTenantTransaction pins search_path
   * to the tenant schema so the per-tenant report row routes correctly
   * (outbox_events keeps its pinned `farm` schema and is unaffected).
   * Idempotency on `klientReferanse` prevents a double-submit (retry /
   * double-click) from generating a duplicate urgent email — the report
   * row upserts on the same key.
   */
  private async enqueue(
    tenantId: string,
    userId: string,
    reportType: RegulatoryReportType,
    input: SubmitWelfareEventInput | SubmitEscapeReportInput | SubmitDiseaseOutbreakInput,
    event: WelfareEventReportedEvent | EscapeReportedEvent | DiseaseOutbreakReportedEvent,
    reportLabel: string,
  ): Promise<ReportSubmissionResult> {
    const { klientReferanse } = input;
    this.logger.log(`Submitting ${reportLabel} varsling report: ${klientReferanse}`);

    try {
      const row = await runInTenantTransaction(
        this.dataSource,
        'farm',
        tenantId,
        async (queryRunner) => {
          const persisted = await this.reportStore.recordQueued(
            queryRunner.manager,
            tenantId,
            {
              reportType,
              klientReferanse,
              siteId: input.siteId,
              lokalitetsnummer: input.lokalitetsnummer,
              payload: input,
              submittedBy: userId,
            },
            event.eventId,
          );
          await this.outboxPublisher.enqueue(event, queryRunner.manager, {
            idempotencyKey: `varsling:${event.eventType}:${klientReferanse}`,
            aggregateId: input.siteId,
          });
          return persisted;
        },
      );

      this.logger.log(`${reportLabel} varsling report queued for dispatch: ${klientReferanse}`);
      return {
        success: true,
        reportId: row.id,
        referanse: event.eventId,
        klientReferanse,
      };
    } catch (error) {
      this.logger.error(
        `Failed to submit ${reportLabel} varsling report: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        success: false,
        klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
