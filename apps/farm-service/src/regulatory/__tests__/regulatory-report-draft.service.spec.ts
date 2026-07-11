/**
 * RegulatoryReportDraftService — the operator draft-review workflow (RPT-003).
 *
 * Locks the contract:
 *   - listDeadlines filters terminal + undated drafts and resolves overdue /
 *     days-until in the Oslo calendar;
 *   - refreshDraft re-assembles and flips READY↔DRAFT on the recomputed blocking
 *     verdict while preserving operator overrides;
 *   - saveOverrides fills blocking MANUAL_REQUIRED fields but REJECTS a
 *     RECORDS/SENSOR pointer (corrections flow to the source record) and an
 *     unknown pointer;
 *   - terminal drafts (SUBMITTED / DISMISSED) are immutable for every mutation.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { RegulatoryReportDraftService } from '../services/regulatory-report-draft.service';
import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { ReportFieldProvenance } from '../assembly/provenance.types';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const SITE = 'ssssssss-1111-4222-8333-444444444444';

function makeDraft(overrides: Partial<RegulatoryReportDraft> = {}): RegulatoryReportDraft {
  const draft = new RegulatoryReportDraft();
  draft.id = 'draft-1';
  draft.tenantId = TENANT;
  draft.reportType = ReportPrefillType.SEA_LICE;
  draft.siteId = SITE;
  draft.periodYear = 2026;
  draft.periodWeek = 27;
  draft.status = ReportDraftStatus.DRAFT;
  draft.assembledPayload = {};
  draft.fieldMeta = [];
  draft.schemaValid = false;
  draft.dueAt = '2026-07-07';
  draft.assembledAt = new Date('2026-07-06T03:00:00Z');
  Object.assign(draft, overrides);
  return draft;
}

describe('RegulatoryReportDraftService', () => {
  let service: RegulatoryReportDraftService;
  let find: jest.Mock;
  let findOne: jest.Mock;
  let save: jest.Mock;
  let assemble: jest.Mock;
  let logWithManager: jest.Mock;

  beforeEach(() => {
    find = jest.fn().mockResolvedValue([]);
    findOne = jest.fn().mockResolvedValue(null);
    save = jest.fn().mockImplementation((d: RegulatoryReportDraft) => Promise.resolve(d));
    assemble = jest.fn();

    // COMPLIANCE-HIGH-001: the audited lifecycle mutations persist the draft
    // AND the audit row in one repo.manager.transaction. The manager double
    // runs the callback with a save that echoes the entity (mirroring the
    // scoped-repo save) so the mutated draft is still the method's return.
    const managerSave = jest
      .fn()
      .mockImplementation((_entity: unknown, d: RegulatoryReportDraft) => Promise.resolve(d));
    const transaction = jest
      .fn()
      .mockImplementation((cb: (mgr: { save: jest.Mock }) => unknown) =>
        Promise.resolve(cb({ save: managerSave })),
      );
    const repo: Pick<
      Repository<RegulatoryReportDraft>,
      'find' | 'findOne' | 'save' | 'manager'
    > = {
      find,
      findOne,
      save,
      manager: { transaction } as Partial<EntityManager> as EntityManager,
    };
    const assembly: Pick<ReportAssemblyService, 'assemble'> = { assemble };
    logWithManager = jest.fn().mockResolvedValue(undefined);
    const auditLog = {
      logWithManager,
    } as Partial<AuditLogService> as AuditLogService;

    service = new RegulatoryReportDraftService(
      repo as Repository<RegulatoryReportDraft>,
      assembly as ReportAssemblyService,
      auditLog,
    );
  });

  describe('listDeadlines', () => {
    it('resolves overdue / days-until in Oslo over the SQL-filtered candidate set', async () => {
      // Terminal + undated drafts are now excluded in SQL (PERF-HIGH-003); the
      // query returns only non-terminal dated drafts.
      find.mockResolvedValue([
        makeDraft({ id: 'd-open', dueAt: '2026-07-09', status: ReportDraftStatus.READY }),
        makeDraft({ id: 'd-overdue', dueAt: '2026-07-04', status: ReportDraftStatus.DRAFT }),
      ]);

      const rows = await service.listDeadlines(TENANT, new Date('2026-07-06T09:00:00Z'));

      expect(rows.map((r) => r.id)).toEqual(['d-open', 'd-overdue']);
      const open = rows.find((r) => r.id === 'd-open');
      expect(open).toMatchObject({ overdue: false, daysUntilDue: 3 });
      const overdue = rows.find((r) => r.id === 'd-overdue');
      expect(overdue).toMatchObject({ overdue: true, daysUntilDue: -2 });

      // The exclusion is pushed to SQL: non-terminal status + dueAt IS NOT NULL.
      const where = find.mock.calls.at(-1)?.[0]?.where;
      expect(where).toMatchObject({ tenantId: TENANT });
      expect(where.status).toBeDefined(); // Not(In([SUBMITTED, DISMISSED]))
      expect(where.dueAt).toBeDefined(); // Not(IsNull())
    });
  });

  describe('refreshDraft', () => {
    it('re-assembles and flips DRAFT → READY when no blocking fields remain', async () => {
      findOne.mockResolvedValue(makeDraft({ status: ReportDraftStatus.DRAFT, schemaValid: false }));
      assemble.mockResolvedValue({
        draftPayload: { rapporteringsuke: 27 },
        fields: [
          {
            path: '/sjøtemperatur',
            provenance: ReportFieldProvenance.SENSOR,
            blocking: false,
          },
        ],
        schemaValid: true,
        assembledAt: new Date('2026-07-06T04:00:00Z'),
      });

      const result = await service.refreshDraft(TENANT, 'draft-1');

      expect(assemble).toHaveBeenCalledWith(TENANT, ReportPrefillType.SEA_LICE, SITE, {
        year: 2026,
        week: 27,
        month: undefined,
      });
      expect(result.status).toBe(ReportDraftStatus.READY);
      expect(result.schemaValid).toBe(true);
      expect(result.assembledPayload).toEqual({ rapporteringsuke: 27 });
    });

    it('stays DRAFT while a blocking MANUAL_REQUIRED field has no override', async () => {
      findOne.mockResolvedValue(makeDraft());
      assemble.mockResolvedValue({
        draftPayload: {},
        fields: [
          {
            path: '/lusetelling',
            provenance: ReportFieldProvenance.MANUAL_REQUIRED,
            blocking: true,
          },
        ],
        schemaValid: false,
        assembledAt: new Date('2026-07-06T04:00:00Z'),
      });

      const result = await service.refreshDraft(TENANT, 'draft-1');

      expect(result.status).toBe(ReportDraftStatus.DRAFT);
      expect(result.schemaValid).toBe(false);
    });

    it('a preserved override satisfies its blocking field on re-assembly', async () => {
      findOne.mockResolvedValue(
        makeDraft({ manualOverrides: { '/lusetelling': { voksneHunnlus: 0.2 } } }),
      );
      assemble.mockResolvedValue({
        draftPayload: {},
        fields: [
          {
            path: '/lusetelling',
            provenance: ReportFieldProvenance.MANUAL_REQUIRED,
            blocking: true,
          },
        ],
        schemaValid: false,
        assembledAt: new Date('2026-07-06T04:00:00Z'),
      });

      const result = await service.refreshDraft(TENANT, 'draft-1');

      expect(result.status).toBe(ReportDraftStatus.READY);
      expect(result.schemaValid).toBe(true);
    });

    it('throws on a terminal draft', async () => {
      findOne.mockResolvedValue(makeDraft({ status: ReportDraftStatus.SUBMITTED }));
      await expect(service.refreshDraft(TENANT, 'draft-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(assemble).not.toHaveBeenCalled();
    });

    it('throws NotFound when the draft does not exist', async () => {
      findOne.mockResolvedValue(null);
      await expect(service.refreshDraft(TENANT, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('saveOverrides', () => {
    const blockingManual = {
      path: '/lusetelling',
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    };
    const recordsField = {
      path: '/rapporteringsuke',
      provenance: ReportFieldProvenance.RECORDS,
      blocking: false,
    };

    it('fills a blocking MANUAL_REQUIRED field and flips the draft READY', async () => {
      findOne.mockResolvedValue(makeDraft({ fieldMeta: [blockingManual] }));

      const result = await service.saveOverrides(
        TENANT,
        'draft-1',
        { '/lusetelling': { voksneHunnlus: 0.3 } },
        'actor-user',
      );

      expect(result.manualOverrides).toEqual({ '/lusetelling': { voksneHunnlus: 0.3 } });
      expect(result.status).toBe(ReportDraftStatus.READY);
      expect(result.schemaValid).toBe(true);
      // COMPLIANCE-HIGH-001: the override is audited with the actor.
      expect(logWithManager).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: AuditAction.REGULATORY_OVERRIDDEN,
          entityType: 'RegulatoryReportDraft',
          entityId: 'draft-1',
          userId: 'actor-user',
        }),
      );
    });

    it('rejects an override targeting a RECORDS field', async () => {
      findOne.mockResolvedValue(makeDraft({ fieldMeta: [blockingManual, recordsField] }));

      await expect(
        service.saveOverrides(TENANT, 'draft-1', { '/rapporteringsuke': 30 }, 'actor-user'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(save).not.toHaveBeenCalled();
    });

    it('rejects an override pointer that is not a field of the draft', async () => {
      findOne.mockResolvedValue(makeDraft({ fieldMeta: [blockingManual] }));

      await expect(
        service.saveOverrides(TENANT, 'draft-1', { '/unknown': 1 }, 'actor-user'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on a terminal draft', async () => {
      findOne.mockResolvedValue(
        makeDraft({ status: ReportDraftStatus.DISMISSED, fieldMeta: [blockingManual] }),
      );
      await expect(
        service.saveOverrides(TENANT, 'draft-1', { '/lusetelling': {} }, 'actor-user'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('dismissDraft', () => {
    it('sets DISMISSED on a non-terminal draft', async () => {
      findOne.mockResolvedValue(makeDraft({ status: ReportDraftStatus.READY }));
      const result = await service.dismissDraft(TENANT, 'draft-1', 'actor-user');
      expect(result.status).toBe(ReportDraftStatus.DISMISSED);
      // COMPLIANCE-HIGH-001: the dismissal is audited with the actor.
      expect(logWithManager).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: AuditAction.REGULATORY_DISMISSED,
          entityType: 'RegulatoryReportDraft',
          userId: 'actor-user',
        }),
      );
    });

    it('throws on an already-submitted draft', async () => {
      findOne.mockResolvedValue(makeDraft({ status: ReportDraftStatus.SUBMITTED }));
      await expect(service.dismissDraft(TENANT, 'draft-1', 'actor-user')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('markSubmitted (approve)', () => {
    it('links the receipt, stamps the approver, and audits REGULATORY_APPROVED', async () => {
      findOne.mockResolvedValue(makeDraft({ status: ReportDraftStatus.READY }));

      const result = await service.markSubmitted(TENANT, 'draft-1', 'report-99', 'approver-1');

      expect(result.status).toBe(ReportDraftStatus.SUBMITTED);
      expect(result.submittedReportId).toBe('report-99');
      expect(result.approvedBy).toBe('approver-1');
      // COMPLIANCE-HIGH-001: the human approval decision is audited, keyed to
      // the approver — distinct from the REGULATORY_SUBMITTED wire event the
      // store writes for the resulting regulatory_reports row.
      expect(logWithManager).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: AuditAction.REGULATORY_APPROVED,
          entityType: 'RegulatoryReportDraft',
          entityId: 'draft-1',
          userId: 'approver-1',
        }),
      );
    });
  });
});
