import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import type {
  WelfareEventReportedEvent,
  EscapeReportedEvent,
  DiseaseOutbreakReportedEvent,
} from '@platform/event-contracts';
import { EmailService, RegulatoryReportEmailData } from '../services/email.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RegulatoryVarslingEvent =
  | WelfareEventReportedEvent
  | EscapeReportedEvent
  | DiseaseOutbreakReportedEvent;

/**
 * Regulatory Report Event Handler
 *
 * Consumes the THREE legally-immediate Mattilsynet "varsling" events emitted
 * by farm-service and dispatches the corresponding urgent email to
 * varsling.akva@mattilsynet.no (escapes also CC the site manager). This is the
 * real submission channel for welfare / escape / disease reports — they have
 * no Mattilsynet REST endpoint.
 *
 * The EmailService templates (sendWelfareEventEmail / sendEscapeReportEmail /
 * sendDiseaseOutbreakEmail) already existed; this handler is the previously
 * missing wire that drives them.
 *
 * Subscribed events:
 * - WelfareEventReported
 * - EscapeReported
 * - DiseaseOutbreakReported
 */
@Injectable()
export class RegulatoryReportEventHandler
  implements IEventHandler<RegulatoryVarslingEvent>, OnModuleInit
{
  private readonly logger = new Logger(RegulatoryReportEventHandler.name);

  constructor(
    private readonly emailService: EmailService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: one notification-service instance dispatches
    // every tenant's regulatory varsling emails. The helper builds
    // `events.*.{eventType}`, matching the publisher's
    // `events.{tenantId}.{eventType}`.
    await this.eventBus.subscribeWildcard('WelfareEventReported', this);
    await this.eventBus.subscribeWildcard('EscapeReported', this);
    await this.eventBus.subscribeWildcard('DiseaseOutbreakReported', this);
    this.logger.log(
      'Subscribed to WelfareEventReported, EscapeReported, and DiseaseOutbreakReported events (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'RegulatoryReportEvent';
  }

  async handle(event: RegulatoryVarslingEvent): Promise<HandlerOutcome> {
    // SECURITY: validate tenantId format to ensure isolation before any
    // downstream PII (contact person) is rendered into an email.
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        'Regulatory varsling event has invalid or missing tenantId. ' +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('Regulatory varsling: missing or invalid tenantId');
    }

    const eventType = event.eventType;
    this.logger.log(`Processing ${eventType} for tenant ${event.tenantId.substring(0, 8)}...`);

    switch (eventType) {
      case 'WelfareEventReported':
        await this.handleWelfare(event);
        break;
      case 'EscapeReported':
        await this.handleEscape(event);
        break;
      case 'DiseaseOutbreakReported':
        await this.handleDisease(event);
        break;
      default:
        this.logger.warn(`Unknown regulatory varsling event type: ${eventType}`);
        return HandlerOutcome.terminate(`Unknown regulatory varsling event type: ${eventType}`);
    }
    return HandlerOutcome.ack();
  }

  /**
   * Shared identity block → EmailService contract. Kept as one mapper so all
   * three handlers stamp recipient/contact data identically.
   */
  private baseEmailData(
    event: RegulatoryVarslingEvent,
  ): Omit<RegulatoryReportEmailData, 'reportType' | 'welfareData' | 'escapeData' | 'diseaseData'> {
    return {
      siteName: event.siteName,
      siteCode: event.siteCode ?? '',
      lokalitetsnummer: String(event.lokalitetsnummer),
      organisasjonsnummer: event.organisasjonsnummer,
      contactPerson: event.kontaktperson.navn,
      contactEmail: event.kontaktperson.epost,
      contactPhone: event.kontaktperson.telefonnummer,
      detectedAt: new Date(event.detectedAt),
      reportedBy: event.reportedBy,
      siteManagerEmail: event.siteManagerEmail,
    };
  }

  private async handleWelfare(event: WelfareEventReportedEvent): Promise<void> {
    const result = await this.emailService.sendWelfareEventEmail({
      ...this.baseEmailData(event),
      welfareData: {
        eventType: event.welfareEventType,
        severity: event.severity,
        mortalityRate: event.mortalityRate,
        mortalityPeriod: event.mortalityPeriod,
        affectedBatches: event.affectedBatches,
        description: event.description,
        immediateActions: event.immediateActions,
      },
    });
    this.logger.log(
      `Welfare varsling email dispatched (${event.klientReferanse}) to ${result.sentTo.length} recipient(s)`,
    );
  }

  private async handleEscape(event: EscapeReportedEvent): Promise<void> {
    const result = await this.emailService.sendEscapeReportEmail({
      ...this.baseEmailData(event),
      escapeData: {
        estimatedCount: event.estimatedCount,
        species: event.species,
        avgWeightG: event.avgWeightG,
        totalBiomassKg: event.totalBiomassKg,
        cause: event.cause,
        affectedUnits: event.affectedUnits,
        recoveryOngoing: event.recoveryOngoing,
      },
    });
    this.logger.log(
      `Escape varsling email dispatched (${event.klientReferanse}) to ${result.sentTo.length} recipient(s)`,
    );
  }

  private async handleDisease(event: DiseaseOutbreakReportedEvent): Promise<void> {
    const result = await this.emailService.sendDiseaseOutbreakEmail({
      ...this.baseEmailData(event),
      diseaseData: {
        diseaseCategory: event.diseaseCategory,
        diseaseName: event.diseaseName,
        confirmation: event.confirmation,
        affectedCount: event.affectedCount,
        affectedPercentage: event.affectedPercentage,
        clinicalSigns: event.clinicalSigns,
        veterinarianNotified: event.veterinarianNotified,
        veterinarianName: event.veterinarianName,
      },
    });
    this.logger.log(
      `Disease varsling email dispatched (${event.klientReferanse}) to ${result.sentTo.length} recipient(s)`,
    );
  }
}
