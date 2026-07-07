/**
 * RegulatoryDraftSubmissionService (RPT-003/RPT-018) — turns a review-ready
 * report DRAFT into a Mattilsynet submission.
 *
 * This is the ONE place a draft becomes a wire payload, shared by the operator
 * "approve & submit" mutation and the scheduler's auto-submit path:
 *   - buildWirePayload merges the assembled body + operator overrides with the
 *     submission header (organisasjonsnummer, lokalitetsnummer, kontaktperson)
 *     the assembler deliberately does NOT carry, and stamps klientReferanse =
 *     draft.id so a re-approval / retry is idempotent against the same
 *     regulatory_reports row (Mattilsynet's own idempotency key);
 *   - approveAndSubmit validates through the brand gate, delegates the persist +
 *     classify + retry-scheduling to RegulatorySubmissionService.submitWithRecord
 *     (no duplicated outcome handling), and on acceptance links the draft to its
 *     receipt (SUBMITTED + submittedReportId).
 *
 * Fail-closed: a draft with blocking fields, an unmapped lokalitetsnummer, or a
 * missing organisation number / contact cannot be submitted — the operator is
 * told exactly what to configure.
 *
 * Runs correctly in BOTH a request (resolver) and cron (auto-submit) because
 * every collaborator resolves the tenant from the ambient tenant context
 * (the scheduler now wraps per-tenant work in withTenantContext).
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { MattilsynetApiService, MattilsynetBasePayload } from '../mattilsynet-api.service';
import { MattilsynetSchemaValidatorService } from './mattilsynet-schema-validator.service';
import { MattilsynetSchemaValidationError } from './mattilsynet-schema-validator.service';
import { RegulatorySubmissionService } from './regulatory-submission.service';
import { RegulatoryReportDraftService } from './regulatory-report-draft.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';
import { isMattilsynetRestReportType, MattilsynetRestReportType } from '../schemas';
import { ReportSubmissionResult } from '../dto/regulatory-inputs.dto';
import { setByPointer } from './json-pointer.util';

/**
 * Actor stamped on an automated (scheduler) submission. The all-zero UUID marks
 * a system action in the regulatory_reports.submittedBy / draft.approvedBy audit
 * columns (distinct from any real operator id).
 */
export const AUTO_SUBMIT_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

const TERMINAL_STATUSES: ReadonlySet<ReportDraftStatus> = new Set([
  ReportDraftStatus.SUBMITTED,
  ReportDraftStatus.DISMISSED,
]);

@Injectable()
export class RegulatoryDraftSubmissionService {
  private readonly logger = new Logger(RegulatoryDraftSubmissionService.name);

  constructor(
    private readonly draftService: RegulatoryReportDraftService,
    private readonly submissionService: RegulatorySubmissionService,
    private readonly mattilsynetApi: MattilsynetApiService,
    private readonly schemaValidator: MattilsynetSchemaValidatorService,
    private readonly settingsService: RegulatorySettingsService,
  ) {}

  /**
   * Approve a READY draft and submit it to Mattilsynet. On acceptance the draft
   * is linked to its persisted receipt (SUBMITTED). A failure leaves the draft
   * as-is so the operator can correct the source records and retry.
   */
  async approveAndSubmit(
    tenantId: string,
    userId: string,
    draftId: string,
  ): Promise<ReportSubmissionResult> {
    const draft = await this.draftService.getDraftOrThrow(tenantId, draftId);

    if (TERMINAL_STATUSES.has(draft.status)) {
      throw new BadRequestException(
        `Cannot submit a ${draft.status} report draft — terminal states are immutable`,
      );
    }
    if (!draft.schemaValid) {
      throw new BadRequestException(
        'Report draft still has blocking fields — fill the required values before submitting',
      );
    }
    const reportType = toRestReportType(draft.reportType);

    const { wire, lokalitetsnummer } = await this.buildWirePayload(tenantId, draft);

    let validated;
    try {
      validated = this.schemaValidator.validate<MattilsynetBasePayload>(reportType, wire);
    } catch (error) {
      if (error instanceof MattilsynetSchemaValidationError) {
        return {
          success: false,
          klientReferanse: draft.id,
          feilmelding: 'Draft failed official Mattilsynet schema validation',
          valideringsfeil: error.valideringsfeil,
        };
      }
      throw error;
    }

    const result = await this.submissionService.submitWithRecord(
      tenantId,
      userId,
      reportType,
      { klientReferanse: draft.id, siteId: draft.siteId, lokalitetsnummer },
      { year: draft.periodYear, week: draft.periodWeek, month: draft.periodMonth },
      wire,
      () => this.mattilsynetApi.submitByType(tenantId, reportType, validated),
    );

    if (result.success && result.reportId) {
      await this.draftService.markSubmitted(tenantId, draftId, result.reportId, userId);
      this.logger.log(
        `Draft ${draftId.slice(0, 8)}… submitted (${reportType}), receipt ${result.reportId}`,
      );
    }
    return result;
  }

  /**
   * Build the exact Mattilsynet wire payload for a draft: the assembled body +
   * operator overrides, plus the submission header resolved from settings/site.
   * Fails closed when any required identity/contact value is missing.
   */
  private async buildWirePayload(
    tenantId: string,
    draft: RegulatoryReportDraft,
  ): Promise<{ wire: MattilsynetBasePayload; lokalitetsnummer: number }> {
    const [settings, orgNumber, mappings] = await Promise.all([
      this.settingsService.getSettings(tenantId),
      this.settingsService.getEffectiveOrganisationNumber(tenantId, draft.siteId),
      this.settingsService.getEffectiveSiteLocalityMappings(tenantId),
    ]);

    const lokalitetsnummer = mappings[draft.siteId];
    if (lokalitetsnummer === undefined) {
      throw new BadRequestException(
        `Site has no lokalitetsnummer — configure it in Setup → Sites before submitting`,
      );
    }
    if (!orgNumber) {
      throw new BadRequestException(
        'No organisation number configured (Setup → Regulatory settings) — cannot submit',
      );
    }
    const navn = settings?.defaultContactName;
    const epost = settings?.defaultContactEmail;
    const telefonnummer = settings?.defaultContactPhone;
    if (!navn || !epost || !telefonnummer) {
      throw new BadRequestException(
        'Default contact (name, email, phone) is incomplete in Setup → Regulatory settings — ' +
          'Mattilsynet requires a contact person on every report',
      );
    }

    // Deep-clone the stored jsonb body, then apply each override at its pointer.
    const body: Record<string, unknown> = JSON.parse(JSON.stringify(draft.assembledPayload));
    for (const [pointer, value] of Object.entries(draft.manualOverrides ?? {})) {
      setByPointer(body, pointer, value);
    }

    // Header LAST so it always wins over any colliding body key.
    const wire: MattilsynetBasePayload = {
      ...body,
      klientReferanse: draft.id,
      organisasjonsnummer: orgNumber,
      lokalitetsnummer,
      kontaktperson: { navn, epost, telefonnummer },
    };
    return { wire, lokalitetsnummer };
  }
}

/** Resolve the draft's reportType string to a REST report type or reject it. */
function toRestReportType(value: string): MattilsynetRestReportType {
  const rt = Object.values(RegulatoryReportType).find((t) => t === value);
  if (!rt || !isMattilsynetRestReportType(rt)) {
    throw new BadRequestException(
      `Report type "${value}" is not a submittable Mattilsynet REST report`,
    );
  }
  return rt;
}
