/**
 * RegulatoryReportDraftService (RPT-003) — the operator's review workflow over
 * the drafts the scheduler assembles each period.
 *
 * The scheduler owns draft CREATION (period rollover, raw INSERT … ON CONFLICT);
 * this service owns the review lifecycle a logged-in operator drives:
 *   - list drafts / deadlines for the site-reports view;
 *   - refresh — re-assemble from the current source records (READY↔DRAFT flips
 *     as blocking fields appear/disappear);
 *   - saveOverrides — fill the blocking MANUAL_REQUIRED fields ONLY; the server
 *     rejects any attempt to override a RECORDS/SENSOR value (corrections flow
 *     to the source record, never the report — the automated-reporting SSoT);
 *   - dismiss — operator opt-out of a non-applicable draft.
 *
 * Terminal states (SUBMITTED, DISMISSED) are immutable — refresh/override/
 * dismiss on them is a client error, never a silent no-op.
 *
 * Injected scoped repository: the middleware pins search_path to the tenant
 * schema for the request, so a plain find/save lands in tenant_<uuid>
 * (same pattern as RegulatorySettingsService).
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { ReportFieldMeta, ReportFieldProvenance } from '../assembly/provenance.types';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';
import { computeDueDate, isOverdueInOslo, osloDaysUntil } from './report-deadlines';
import { ReportDeadlineOutput, ReportDraftFilterInput } from '../dto/regulatory-report-draft.dto';

const TERMINAL_STATUSES: ReadonlySet<ReportDraftStatus> = new Set([
  ReportDraftStatus.SUBMITTED,
  ReportDraftStatus.DISMISSED,
]);

@Injectable()
export class RegulatoryReportDraftService {
  private readonly logger = new Logger(RegulatoryReportDraftService.name);

  constructor(
    @InjectRepository(RegulatoryReportDraft)
    private readonly repo: Repository<RegulatoryReportDraft>,
    private readonly assemblyService: ReportAssemblyService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * COMPLIANCE-HIGH-001 — persist the draft mutation AND its actor-attributed
   * audit row in one transaction so the audit trail can never diverge from the
   * draft state. The connection is tenant-routed from AsyncLocalStorage at
   * checkout (TenantConnectionBootstrap), so the per-tenant draft save lands in
   * `tenant_<uuid>` while the schema-qualified `farm.farm_audit_logs` write
   * lands in `farm` — both committing atomically.
   */
  private async saveWithAudit(
    tenantId: string,
    draft: RegulatoryReportDraft,
    actor: string,
    action: AuditAction,
    summary: string,
    after: Record<string, unknown>,
  ): Promise<RegulatoryReportDraft> {
    return this.repo.manager.transaction(async (mgr) => {
      const saved = await mgr.save(RegulatoryReportDraft, draft);
      await this.auditLog.logWithManager(mgr, {
        tenantId,
        entityType: 'RegulatoryReportDraft',
        entityId: saved.id,
        action,
        userId: actor,
        changes: { after },
        metadata: { source: 'regulatory-reporting' },
        summary,
      });
      return saved;
    });
  }

  // ==========================================================================
  // READS
  // ==========================================================================

  async listDrafts(
    tenantId: string,
    filter?: ReportDraftFilterInput,
  ): Promise<RegulatoryReportDraft[]> {
    const where: FindOptionsWhere<RegulatoryReportDraft> = { tenantId };
    if (filter?.status) where.status = filter.status;
    if (filter?.reportType) where.reportType = filter.reportType;
    if (filter?.siteId) where.siteId = filter.siteId;
    return this.repo.find({ where, order: { dueAt: 'ASC', createdAt: 'DESC' } });
  }

  /**
   * Drafts that can still breach a deadline: non-terminal (not SUBMITTED/DISMISSED)
   * AND carrying a dueAt. The predicate is pushed into SQL (PERF-HIGH-003) so the
   * daily deadline sweep and the deadline view never load — and then discard in JS —
   * the full, unbounded history of terminal drafts. The `(tenantId, status)` index
   * covers the status filter.
   */
  async listDeadlineCandidates(tenantId: string): Promise<RegulatoryReportDraft[]> {
    return this.repo.find({
      where: {
        tenantId,
        status: Not(In([ReportDraftStatus.SUBMITTED, ReportDraftStatus.DISMISSED])),
        dueAt: Not(IsNull()),
      },
      order: { dueAt: 'ASC' },
    });
  }

  async getDraftOrThrow(tenantId: string, id: string): Promise<RegulatoryReportDraft> {
    const draft = await this.repo.findOne({ where: { id, tenantId } });
    if (!draft) {
      throw new NotFoundException(`Regulatory report draft ${id} not found`);
    }
    return draft;
  }

  /**
   * Non-terminal drafts that carry a deadline, newest-due first, with the
   * overdue flag + days-until resolved in the Oslo calendar for the deadline
   * view / chips.
   */
  async listDeadlines(tenantId: string, now: Date): Promise<ReportDeadlineOutput[]> {
    const drafts = await this.listDeadlineCandidates(tenantId);
    return drafts
      .map((d) => ({
        id: d.id,
        reportType: d.reportType,
        siteId: d.siteId,
        periodYear: d.periodYear,
        periodWeek: d.periodWeek,
        periodMonth: d.periodMonth,
        status: d.status,
        dueAt: d.dueAt,
        overdue: d.dueAt ? isOverdueInOslo(d.dueAt, now) : false,
        daysUntilDue: d.dueAt ? osloDaysUntil(d.dueAt, now) : undefined,
      }));
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Re-assemble the draft from the current source records. The payload +
   * field-meta are rebuilt; status flips READY↔DRAFT on the recomputed blocking
   * verdict (existing operator overrides are preserved and still satisfy their
   * blocking fields). APPROVED is preserved on a still-valid re-assembly.
   */
  async refreshDraft(tenantId: string, id: string): Promise<RegulatoryReportDraft> {
    const draft = await this.getDraftOrThrow(tenantId, id);
    this.assertMutable(draft, 'refresh');

    const prefillType = toPrefillType(draft.reportType);
    const assembled = await this.assemblyService.assemble(tenantId, prefillType, draft.siteId, {
      year: draft.periodYear,
      week: draft.periodWeek,
      month: draft.periodMonth,
    });

    draft.assembledPayload = assembled.draftPayload;
    draft.fieldMeta = assembled.fields;
    draft.assembledAt = assembled.assembledAt;
    draft.dueAt = computeDueDate(prefillType, {
      year: draft.periodYear,
      week: draft.periodWeek,
      month: draft.periodMonth,
    });
    this.applyValidity(draft);
    return this.repo.save(draft);
  }

  /**
   * Merge operator overrides for blocking MANUAL_REQUIRED fields. Rejects any
   * pointer that is NOT a MANUAL_REQUIRED field-meta path — a RECORDS/SENSOR
   * value is corrected at its source record, never patched into the report.
   */
  async saveOverrides(
    tenantId: string,
    id: string,
    overrides: Record<string, unknown>,
    actor: string,
  ): Promise<RegulatoryReportDraft> {
    const draft = await this.getDraftOrThrow(tenantId, id);
    this.assertMutable(draft, 'override');

    const metaByPath = new Map(this.fieldMeta(draft).map((f) => [f.path, f]));
    for (const pointer of Object.keys(overrides)) {
      const meta = metaByPath.get(pointer);
      if (!meta) {
        throw new BadRequestException(
          `Override pointer ${pointer} is not a field of this report draft`,
        );
      }
      if (meta.provenance !== ReportFieldProvenance.MANUAL_REQUIRED) {
        throw new BadRequestException(
          `Field ${pointer} is ${meta.provenance} — correct it at the source record, ` +
            'not in the report draft',
        );
      }
    }

    const overriddenPointers = Object.keys(overrides);
    draft.manualOverrides = { ...(draft.manualOverrides ?? {}), ...overrides };
    this.applyValidity(draft);
    return this.saveWithAudit(
      tenantId,
      draft,
      actor,
      AuditAction.REGULATORY_OVERRIDDEN,
      `Overrode ${overriddenPointers.length} field(s) on ${draft.reportType} draft`,
      { overriddenPointers, status: draft.status, schemaValid: draft.schemaValid },
    );
  }

  async dismissDraft(
    tenantId: string,
    id: string,
    actor: string,
  ): Promise<RegulatoryReportDraft> {
    const draft = await this.getDraftOrThrow(tenantId, id);
    this.assertMutable(draft, 'dismiss');
    draft.status = ReportDraftStatus.DISMISSED;
    return this.saveWithAudit(
      tenantId,
      draft,
      actor,
      AuditAction.REGULATORY_DISMISSED,
      `Dismissed ${draft.reportType} draft for the period`,
      { status: draft.status },
    );
  }

  /**
   * Terminal transition after Mattilsynet accepted the draft's submission:
   * link the persisted regulatory_reports receipt and stamp the approver.
   * Called by RegulatoryDraftSubmissionService inside the same request/cron
   * tenant context as the submit.
   */
  async markSubmitted(
    tenantId: string,
    id: string,
    submittedReportId: string,
    approvedBy: string,
  ): Promise<RegulatoryReportDraft> {
    const draft = await this.getDraftOrThrow(tenantId, id);
    draft.status = ReportDraftStatus.SUBMITTED;
    draft.submittedReportId = submittedReportId;
    draft.approvedBy = approvedBy;
    draft.approvedAt = new Date();
    return this.saveWithAudit(
      tenantId,
      draft,
      approvedBy,
      AuditAction.REGULATORY_APPROVED,
      `Approved ${draft.reportType} draft and filed it (report ${submittedReportId})`,
      { status: draft.status, submittedReportId },
    );
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  /** A field is still blocking iff it is a blocking MANUAL_REQUIRED with no override. */
  private applyValidity(draft: RegulatoryReportDraft): void {
    const overrides = draft.manualOverrides ?? {};
    const remainingBlocking = this.fieldMeta(draft).filter(
      (f) =>
        f.blocking &&
        f.provenance === ReportFieldProvenance.MANUAL_REQUIRED &&
        overrides[f.path] === undefined,
    );
    draft.schemaValid = remainingBlocking.length === 0;
    // Never downgrade an APPROVED draft on re-validation; otherwise the ready
    // verdict drives DRAFT↔READY.
    if (draft.status !== ReportDraftStatus.APPROVED) {
      draft.status = draft.schemaValid ? ReportDraftStatus.READY : ReportDraftStatus.DRAFT;
    }
  }

  private fieldMeta(draft: RegulatoryReportDraft): ReportFieldMeta[] {
    return draft.fieldMeta ?? [];
  }

  private assertMutable(draft: RegulatoryReportDraft, action: string): void {
    if (TERMINAL_STATUSES.has(draft.status)) {
      throw new BadRequestException(
        `Cannot ${action} a ${draft.status} report draft — terminal states are immutable`,
      );
    }
  }
}

/** Resolve the stored reportType string to its ReportPrefillType without a cast. */
function toPrefillType(value: string): ReportPrefillType {
  const match = Object.values(ReportPrefillType).find((t) => t === value);
  if (!match) {
    throw new BadRequestException(`Unknown report type "${value}" on draft`);
  }
  return match;
}
