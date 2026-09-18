/**
 * Regulatory Submission Service (RPT-018) — the ONE place the persist-first
 * Mattilsynet submit flow, failure classification, and retry replay live.
 *
 * Extracted from RegulatoryResolver so both the interactive submit path and the
 * 30-minute retry sweep share identical outcome handling (no duplicated
 * persist/classify logic):
 *   - submitWithRecord() — record PENDING → call the API → apply the outcome.
 *   - resubmit()         — replay a persisted TRANSIENT failure under the SAME
 *                          klientReferanse (Mattilsynet idempotency), re-validating
 *                          the stored payload through the brand gate first.
 *
 * Classification SSoT (classifyFailure): network/timeout/5xx/401/403/408/429 →
 * TRANSIENT (backoff replay); 400/422/valideringsfeil → PERMANENT (terminal +
 * outbox RegulatoryReportSubmissionFailedEvent for the operator). Retrying a
 * PERMANENT failure would only re-send a rejected report.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { RegulatoryReportSubmissionFailedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { classifyHttpStatus } from '@aquaculture/backend-common/http';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';

import {
  MattilsynetApiResponse,
  MattilsynetApiService,
  MattilsynetBasePayload,
} from '../mattilsynet-api.service';
import { MattilsynetSchemaValidatorService } from './mattilsynet-schema-validator.service';
import { MattilsynetSchemaValidationError } from './mattilsynet-schema-validator.service';
import { RegulatoryReportStoreService } from './regulatory-report-store.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import {
  RegulatoryFailureClass,
  RegulatoryReport,
  RegulatoryReportPayload,
  RegulatoryReportType,
  RegulatoryRestWirePayload,
} from '../entities/regulatory-report.entity';
import { isMattilsynetRestReportType, MattilsynetRestReportType } from '../schemas';
import { ReportSubmissionResult } from '../dto/regulatory-inputs.dto';

/** Retry backoff cap: min(2^(attempt-1) × 15 min, 6 h). Full jitter samples within it. */
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

/**
 * Transient-retry ceiling. With the capped backoff this spans several days; a
 * report that still fails after this many attempts is dead-lettered (marked
 * PERMANENT + operator alert) instead of retrying forever — a persistent auth
 * misconfig (403) or a prolonged outage must surface, not loop silently.
 */
const MAX_TRANSIENT_ATTEMPTS = 12;

/** A persisted report whose type + payload are both narrowed to the REST wire shape. */
type PersistedRestReport = RegulatoryReport & {
  reportType: MattilsynetRestReportType;
  payload: RegulatoryRestWirePayload;
};

/**
 * A REST report type guarantees (by the storage contract in
 * regulatory-report.entity.ts) that its persisted payload is the Mattilsynet
 * WIRE payload — every member of RegulatoryRestWirePayload extends
 * MattilsynetBasePayload. Narrowing the whole row in one guard lets the replay
 * path hand both the report type and the payload back through the brand gate
 * with no cast.
 */
function isPersistedRestReport(row: RegulatoryReport): row is PersistedRestReport {
  return isMattilsynetRestReportType(row.reportType);
}

export interface SubmitRecordInput {
  klientReferanse: string;
  siteId?: string;
  lokalitetsnummer: number;
}

@Injectable()
export class RegulatorySubmissionService {
  private readonly logger = new Logger(RegulatorySubmissionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly mattilsynetApi: MattilsynetApiService,
    private readonly schemaValidator: MattilsynetSchemaValidatorService,
    private readonly reportStore: RegulatoryReportStoreService,
    private readonly settingsService: RegulatorySettingsService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Persist-first submit flow shared by the five Mattilsynet REST report types
   * (FARM-HIGH-125): record PENDING → call the API → apply the outcome. A
   * failure to persist PENDING fails the submit — an unrecorded report must
   * never reach the regulator.
   */
  async submitWithRecord(
    tenantId: string,
    userId: string,
    reportType: RegulatoryReportType,
    input: SubmitRecordInput,
    period: { year?: number; week?: number; month?: number },
    payload: RegulatoryReportPayload,
    submit: () => Promise<MattilsynetApiResponse>,
  ): Promise<ReportSubmissionResult> {
    const siteId = await this.resolveSiteId(tenantId, input.siteId, input.lokalitetsnummer);
    const row = await this.reportStore.recordPending(tenantId, {
      reportType,
      klientReferanse: input.klientReferanse,
      siteId,
      lokalitetsnummer: input.lokalitetsnummer,
      reportYear: period.year,
      reportWeek: period.week,
      reportMonth: period.month,
      payload,
      submittedBy: userId,
    });

    // FARM-LOW-134: the submit() call and outcome-persistence are separated so
    // only a real submit() failure marks the row FAILED — a persistence error
    // AFTER a successful regulator call must not relabel an accepted submission.
    let result: MattilsynetApiResponse;
    try {
      result = await submit();
    } catch (error) {
      result = {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
        isNetworkError: true,
      };
    }

    return this.applyOutcome(tenantId, row, result);
  }

  /**
   * Replay a persisted FAILED submission. Re-validates the stored payload
   * through the brand gate (a payload now schema-invalid becomes PERMANENT,
   * never re-sent) and submits under the SAME klientReferanse.
   */
  async resubmit(tenantId: string, reportId: string): Promise<ReportSubmissionResult> {
    const row = await this.reportStore.findById(tenantId, reportId);
    if (!row) {
      return { success: false, feilmelding: `Regulatory report ${reportId} not found` };
    }
    if (!isPersistedRestReport(row)) {
      return {
        success: false,
        reportId,
        feilmelding: `Report type ${row.reportType} is not a resubmittable REST report`,
      };
    }

    let result: MattilsynetApiResponse;
    try {
      // The brand's sole producer — re-validating a stale payload here turns a
      // now-invalid stored payload into a PERMANENT failure instead of a resend.
      const validated = this.schemaValidator.validate<MattilsynetBasePayload>(
        row.reportType,
        row.payload,
      );
      result = await this.mattilsynetApi.submitByType(tenantId, row.reportType, validated);
    } catch (error) {
      if (error instanceof MattilsynetSchemaValidationError) {
        result = {
          success: false,
          klientReferanse: row.klientReferanse,
          feilmelding: 'Stored payload no longer passes the official Mattilsynet schema',
          valideringsfeil: error.valideringsfeil,
        };
      } else {
        result = {
          success: false,
          klientReferanse: row.klientReferanse,
          feilmelding: error instanceof Error ? error.message : 'Unknown error',
          isNetworkError: true,
        };
      }
    }

    return this.applyOutcome(tenantId, row, result);
  }

  // ==========================================================================
  // OUTCOME + CLASSIFICATION (SSoT)
  // ==========================================================================

  private async applyOutcome(
    tenantId: string,
    row: RegulatoryReport,
    result: MattilsynetApiResponse,
  ): Promise<ReportSubmissionResult> {
    if (result.success) {
      try {
        await this.reportStore.markSubmitted(tenantId, row.id, result.referanse);
      } catch (persistError) {
        // The regulator's acceptance STANDS; leave the row for a later reconcile
        // rather than relabelling an accepted submission FAILED.
        this.logger.error(
          `Report ${row.id} accepted by Mattilsynet but persisting the outcome failed: ` +
            `${(persistError as Error).message}. Row left as-is; the acceptance is authoritative.`,
        );
      }
      return {
        success: true,
        reportId: row.id,
        referanse: result.referanse,
        klientReferanse: result.klientReferanse,
      };
    }

    const failureClass = RegulatorySubmissionService.classifyFailure(result);
    const feilmelding =
      result.feilmelding ??
      (result.valideringsfeil?.map((v) => `${v.felt}: ${v.melding}`).join('; ') ||
        'Submission rejected');

    if (failureClass === RegulatoryFailureClass.TRANSIENT) {
      const nextAttempt = row.attemptCount + 1;
      if (nextAttempt >= MAX_TRANSIENT_ATTEMPTS) {
        // Dead-letter (PRODUCT-JOB-HIGH-001): a report that has exhausted its
        // transient-retry budget (a persistent 403 auth misconfig, or a multi-day
        // outage) must stop looping every 6h forever and surface to the operator.
        // Escalate to the terminal PERMANENT path so the retry sweep ignores it and
        // the failure event fires.
        await this.markPermanentFailure(
          tenantId,
          row,
          `${feilmelding} (gave up after ${MAX_TRANSIENT_ATTEMPTS} transient attempts)`,
        );
      } else {
        const nextAttemptAt = RegulatorySubmissionService.computeNextAttempt(nextAttempt);
        await this.reportStore.recordFailure(
          tenantId,
          row.id,
          feilmelding,
          RegulatoryFailureClass.TRANSIENT,
          nextAttemptAt,
        );
      }
    } else {
      await this.markPermanentFailure(tenantId, row, feilmelding);
    }

    return {
      success: false,
      reportId: row.id,
      klientReferanse: result.klientReferanse,
      feilmelding,
      valideringsfeil: result.valideringsfeil,
    };
  }

  /**
   * Terminal failure: mark the row PERMANENT and raise the operator-notification
   * event in ONE transaction so the alert fires iff the row is terminally failed.
   * Used both by a natural PERMANENT rejection and by transient-retry exhaustion.
   */
  private async markPermanentFailure(
    tenantId: string,
    row: RegulatoryReport,
    feilmelding: string,
  ): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const failed = await this.reportStore.applyFailure(
        queryRunner.manager,
        tenantId,
        row.id,
        feilmelding,
        RegulatoryFailureClass.PERMANENT,
        null,
      );
      const event: RegulatoryReportSubmissionFailedEvent = {
        ...createBaseEvent<RegulatoryReportSubmissionFailedEvent>(
          'RegulatoryReportSubmissionFailed',
          tenantId,
          { aggregateId: row.id, aggregateType: 'RegulatoryReport' },
        ),
        reportId: row.id,
        reportType: failed.reportType,
        klientReferanse: failed.klientReferanse,
        siteId: failed.siteId,
        lokalitetsnummer: failed.lokalitetsnummer,
        feilmelding,
        attemptCount: failed.attemptCount,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        idempotencyKey: `regreport-failed:${row.id}:${failed.attemptCount}`,
        aggregateId: row.id,
      });
    });
  }

  /**
   * Transient (retryable) vs permanent (terminal) — the retry decision. The
   * HTTP-status half is the platform-wide classifier (classifyHttpStatus,
   * PLAT-HIGH-902); the Mattilsynet-specific halves (network error, a
   * valideringsfeil list) stay here.
   */
  static classifyFailure(result: MattilsynetApiResponse): RegulatoryFailureClass {
    if (result.isNetworkError) return RegulatoryFailureClass.TRANSIENT;
    // A schema/validation rejection is never fixed by retrying.
    if (result.valideringsfeil?.length) return RegulatoryFailureClass.PERMANENT;
    return classifyHttpStatus(result.httpStatus) === 'transient'
      ? RegulatoryFailureClass.TRANSIENT
      : RegulatoryFailureClass.PERMANENT;
  }

  /**
   * nextAttemptAt for a given (post-increment) attempt number, with FULL JITTER
   * (FARM-MEDIUM-172). Without jitter, every report that failed in the same
   * outage shares an identical deterministic backoff and the whole cohort
   * replays on the exact same sweep tick — a synchronised retry herd that
   * re-hammers a just-recovering government API. Full jitter samples the delay
   * uniformly in [0, cap] so the cohort spreads across sweep ticks. `random` is
   * injectable so the spread is asserted deterministically in tests.
   */
  static computeNextAttempt(
    attempt: number,
    now: Date = new Date(),
    random: () => number = Math.random,
  ): Date {
    const cap = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const backoff = Math.round(random() * cap);
    return new Date(now.getTime() + backoff);
  }

  /** Resolve a site id from an explicit value or the lokalitetsnummer mapping. */
  private async resolveSiteId(
    tenantId: string,
    explicitSiteId: string | undefined,
    lokalitetsnummer: number,
  ): Promise<string | undefined> {
    if (explicitSiteId) return explicitSiteId;
    const mappings = await this.settingsService.getEffectiveSiteLocalityMappings(tenantId);
    for (const [siteId, mappedLokalitet] of Object.entries(mappings)) {
      if (mappedLokalitet === lokalitetsnummer) return siteId;
    }
    return undefined;
  }
}
