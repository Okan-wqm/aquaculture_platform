/**
 * RegulatoryDraftSubmissionService — draft → wire submission (RPT-003/RPT-018).
 *
 * Locks:
 *   - the wire payload = assembled body + operator overrides + the submission
 *     header (org number, lokalitetsnummer, kontaktperson, klientReferanse=draft.id);
 *   - guards: non-REST type, terminal draft, and blocking fields are all rejected;
 *   - fail-closed on a missing lokalitetsnummer / org number / contact;
 *   - a schema-invalid wire returns valideringsfeil without submitting;
 *   - a successful submit links the draft to its receipt (SUBMITTED).
 */
import { BadRequestException } from '@nestjs/common';

import {
  RegulatoryDraftSubmissionService,
  AUTO_SUBMIT_ACTOR_ID,
} from '../services/regulatory-draft-submission.service';
import { RegulatoryReportDraftService } from '../services/regulatory-report-draft.service';
import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { MattilsynetApiService } from '../mattilsynet-api.service';
import {
  MattilsynetSchemaValidatorService,
  MattilsynetSchemaValidationError,
} from '../services/mattilsynet-schema-validator.service';
import {
  RegulatoryReport,
  RegulatoryReportSubmissionStatus,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';
import { ReportPrefillType } from '../assembly/report-assembly.service';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER = 'user-001';
const DRAFT_ID = 'dddddddd-1111-4222-8333-444444444444';
const SITE = 'ssssssss-1111-4222-8333-444444444444';

function makeDraft(overrides: Partial<RegulatoryReportDraft> = {}): RegulatoryReportDraft {
  const draft = new RegulatoryReportDraft();
  draft.id = DRAFT_ID;
  draft.tenantId = TENANT;
  draft.reportType = ReportPrefillType.SEA_LICE;
  draft.siteId = SITE;
  draft.periodYear = 2026;
  draft.periodWeek = 27;
  draft.status = ReportDraftStatus.READY;
  draft.schemaValid = true;
  draft.assembledPayload = { rapporteringsår: 2026, rapporteringsuke: 27, sjøtemperatur: 12 };
  draft.fieldMeta = [];
  draft.assembledAt = new Date('2026-07-06T03:00:00Z');
  Object.assign(draft, overrides);
  return draft;
}

describe('RegulatoryDraftSubmissionService', () => {
  let service: RegulatoryDraftSubmissionService;
  let getDraftOrThrow: jest.Mock;
  let markSubmitted: jest.Mock;
  let submitWithRecord: jest.Mock;
  let findByKlientReferanse: jest.Mock;
  let submitByType: jest.Mock;
  let validate: jest.Mock;
  let getSettings: jest.Mock;
  let getEffectiveOrganisationNumber: jest.Mock;
  let getEffectiveSiteLocalityMappings: jest.Mock;

  beforeEach(() => {
    getDraftOrThrow = jest.fn().mockResolvedValue(makeDraft());
    markSubmitted = jest.fn().mockResolvedValue(undefined);
    submitByType = jest.fn();
    // submitWithRecord forwards the built submit closure's result by default.
    submitWithRecord = jest
      .fn()
      .mockResolvedValue({ success: true, reportId: 'row-1', referanse: 'MT-1' });
    // No existing submission row by default → the normal file path runs.
    findByKlientReferanse = jest.fn().mockResolvedValue(null);
    validate = jest.fn().mockImplementation((_t, payload) => payload);
    getSettings = jest.fn().mockResolvedValue({
      defaultContactName: 'Ola',
      defaultContactEmail: 'ola@farm.no',
      defaultContactPhone: '+4790000000',
    });
    getEffectiveOrganisationNumber = jest.fn().mockResolvedValue('987654321');
    getEffectiveSiteLocalityMappings = jest.fn().mockResolvedValue({ [SITE]: 12345 });

    const draftService: Pick<RegulatoryReportDraftService, 'getDraftOrThrow' | 'markSubmitted'> = {
      getDraftOrThrow,
      markSubmitted,
    };
    const submissionService: Pick<RegulatorySubmissionService, 'submitWithRecord'> = {
      submitWithRecord,
    };
    const reportStore: Pick<RegulatoryReportStoreService, 'findByKlientReferanse'> = {
      findByKlientReferanse,
    };
    const api: Pick<MattilsynetApiService, 'submitByType'> = { submitByType };
    const validator: Pick<MattilsynetSchemaValidatorService, 'validate'> = { validate };
    const settings: Pick<
      RegulatorySettingsService,
      'getSettings' | 'getEffectiveOrganisationNumber' | 'getEffectiveSiteLocalityMappings'
    > = { getSettings, getEffectiveOrganisationNumber, getEffectiveSiteLocalityMappings };

    service = new RegulatoryDraftSubmissionService(
      draftService as RegulatoryReportDraftService,
      submissionService as RegulatorySubmissionService,
      reportStore as RegulatoryReportStoreService,
      api as MattilsynetApiService,
      validator as MattilsynetSchemaValidatorService,
      settings as RegulatorySettingsService,
    );
  });

  function existingReport(over: Partial<RegulatoryReport> = {}): RegulatoryReport {
    const row = new RegulatoryReport();
    row.id = 'row-existing';
    row.tenantId = TENANT;
    row.reportType = RegulatoryReportType.SEA_LICE;
    row.klientReferanse = DRAFT_ID;
    row.status = RegulatoryReportSubmissionStatus.SUBMITTED;
    row.referanse = 'MT-existing';
    row.attemptCount = 1;
    Object.assign(row, over);
    return row;
  }

  it('builds the wire payload = body + header and submits, linking the receipt', async () => {
    const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);

    expect(result.success).toBe(true);
    // The header is merged onto the assembled body with klientReferanse = draft id.
    expect(validate).toHaveBeenCalledWith(
      RegulatoryReportType.SEA_LICE,
      expect.objectContaining({
        klientReferanse: DRAFT_ID,
        organisasjonsnummer: '987654321',
        lokalitetsnummer: 12345,
        kontaktperson: { navn: 'Ola', epost: 'ola@farm.no', telefonnummer: '+4790000000' },
        rapporteringsår: 2026,
        sjøtemperatur: 12,
      }),
    );
    expect(submitWithRecord).toHaveBeenCalledWith(
      TENANT,
      USER,
      RegulatoryReportType.SEA_LICE,
      { klientReferanse: DRAFT_ID, siteId: SITE, lokalitetsnummer: 12345 },
      { year: 2026, week: 27, month: undefined },
      expect.objectContaining({ klientReferanse: DRAFT_ID }),
      expect.any(Function),
    );
    expect(markSubmitted).toHaveBeenCalledWith(TENANT, DRAFT_ID, 'row-1', USER);
  });

  it('applies operator overrides onto the body before submitting', async () => {
    getDraftOrThrow.mockResolvedValue(
      makeDraft({
        assembledPayload: { rapporteringsår: 2026, rapporteringsuke: 27, lusetelling: null },
        manualOverrides: { '/lusetelling': { voksneHunnlus: 0.4 } },
      }),
    );

    await service.approveAndSubmit(TENANT, USER, DRAFT_ID);

    expect(validate).toHaveBeenCalledWith(
      RegulatoryReportType.SEA_LICE,
      expect.objectContaining({ lusetelling: { voksneHunnlus: 0.4 } }),
    );
  });

  it('rejects a draft with blocking fields', async () => {
    getDraftOrThrow.mockResolvedValue(makeDraft({ schemaValid: false }));
    await expect(service.approveAndSubmit(TENANT, USER, DRAFT_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(submitWithRecord).not.toHaveBeenCalled();
  });

  it('rejects a terminal draft', async () => {
    getDraftOrThrow.mockResolvedValue(makeDraft({ status: ReportDraftStatus.SUBMITTED }));
    await expect(service.approveAndSubmit(TENANT, USER, DRAFT_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-REST (biomass/varsling) draft type', async () => {
    getDraftOrThrow.mockResolvedValue(makeDraft({ reportType: ReportPrefillType.BIOMASS }));
    await expect(service.approveAndSubmit(TENANT, USER, DRAFT_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('fails closed when the site has no lokalitetsnummer', async () => {
    getEffectiveSiteLocalityMappings.mockResolvedValue({});
    await expect(service.approveAndSubmit(TENANT, USER, DRAFT_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(submitWithRecord).not.toHaveBeenCalled();
  });

  it('fails closed when the contact is incomplete', async () => {
    getSettings.mockResolvedValue({
      defaultContactName: 'Ola',
      defaultContactEmail: 'ola@farm.no',
    });
    await expect(service.approveAndSubmit(TENANT, USER, DRAFT_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns valideringsfeil without submitting when the wire fails schema validation', async () => {
    validate.mockImplementation(() => {
      throw new MattilsynetSchemaValidationError(RegulatoryReportType.SEA_LICE, [
        { felt: 'lusetelling', melding: 'påkrevd' },
      ]);
    });

    const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);

    expect(result.success).toBe(false);
    expect(result.valideringsfeil).toEqual([{ felt: 'lusetelling', melding: 'påkrevd' }]);
    expect(submitWithRecord).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('does NOT link the draft when the submission fails', async () => {
    submitWithRecord.mockResolvedValue({ success: false, feilmelding: 'boom' });
    const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);
    expect(result.success).toBe(false);
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  describe('reconciliation against the submission SSoT (PRODUCT-JOB-CRITICAL-002)', () => {
    it('reconciles + returns the receipt WITHOUT re-filing when the report is already SUBMITTED', async () => {
      // The retry sweep accepted the report out-of-band; the draft is still READY.
      findByKlientReferanse.mockResolvedValue(
        existingReport({ status: RegulatoryReportSubmissionStatus.SUBMITTED, referanse: 'MT-9' }),
      );

      const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);

      expect(result).toEqual({
        success: true,
        reportId: 'row-existing',
        referanse: 'MT-9',
        klientReferanse: DRAFT_ID,
      });
      // No re-POST, no duplicate persist — just draft reconciliation to the receipt.
      expect(submitWithRecord).not.toHaveBeenCalled();
      expect(markSubmitted).toHaveBeenCalledWith(TENANT, DRAFT_ID, 'row-existing', USER);
    });

    it('treats a QUEUED varsling-style row as already filed (idempotent, no re-POST)', async () => {
      findByKlientReferanse.mockResolvedValue(
        existingReport({ status: RegulatoryReportSubmissionStatus.QUEUED }),
      );
      const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);
      expect(result.success).toBe(true);
      expect(submitWithRecord).not.toHaveBeenCalled();
    });

    it('auto-submit does NOT re-file a report that is FAILED (owned by the retry sweep / operator)', async () => {
      findByKlientReferanse.mockResolvedValue(
        existingReport({ status: RegulatoryReportSubmissionStatus.FAILED, attemptCount: 3 }),
      );

      const result = await service.approveAndSubmit(TENANT, AUTO_SUBMIT_ACTOR_ID, DRAFT_ID);

      expect(result.success).toBe(false);
      expect(result.feilmelding).toMatch(/auto-submit does not re-file/i);
      expect(submitWithRecord).not.toHaveBeenCalled();
      expect(markSubmitted).not.toHaveBeenCalled();
    });

    it('an EXPLICIT operator re-approval of a FAILED report is allowed to retry (files again)', async () => {
      findByKlientReferanse.mockResolvedValue(
        existingReport({ status: RegulatoryReportSubmissionStatus.FAILED, attemptCount: 3 }),
      );

      const result = await service.approveAndSubmit(TENANT, USER, DRAFT_ID);

      // operator (not AUTO_SUBMIT_ACTOR_ID) falls through to the normal submit path
      expect(result.success).toBe(true);
      expect(submitWithRecord).toHaveBeenCalledTimes(1);
    });
  });
});
