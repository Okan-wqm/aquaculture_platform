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

@Injectable()
export class RegulatoryVarslingService {
  private readonly logger = new Logger(RegulatoryVarslingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
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

    return this.enqueue(input.klientReferanse, event, input.siteId, 'Welfare Event');
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

    return this.enqueue(input.klientReferanse, event, input.siteId, 'Escape Report');
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

    return this.enqueue(input.klientReferanse, event, input.siteId, 'Disease Outbreak');
  }

  /**
   * Enqueue the varsling event in its own transaction so the outbox INSERT
   * commits atomically. The dedicated transaction (rather than piggy-backing
   * on a domain write) is correct here because the report has no separate
   * domain-row write — the event IS the submission record. Idempotency on
   * `klientReferanse` prevents a double-submit (e.g. retry / double-click)
   * from generating a duplicate urgent email.
   */
  private async enqueue(
    klientReferanse: string,
    event: WelfareEventReportedEvent | EscapeReportedEvent | DiseaseOutbreakReportedEvent,
    aggregateId: string,
    reportLabel: string,
  ): Promise<ReportSubmissionResult> {
    this.logger.log(`Submitting ${reportLabel} varsling report: ${klientReferanse}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        idempotencyKey: `varsling:${event.eventType}:${klientReferanse}`,
        aggregateId,
      });
      await queryRunner.commitTransaction();

      this.logger.log(`${reportLabel} varsling report queued for dispatch: ${klientReferanse}`);
      return {
        success: true,
        referanse: event.eventId,
        klientReferanse,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to submit ${reportLabel} varsling report: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        success: false,
        klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await queryRunner.release();
    }
  }
}
