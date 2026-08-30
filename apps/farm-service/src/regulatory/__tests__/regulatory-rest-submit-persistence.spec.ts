/**
 * REST report resolver — schema gate + delegation (FARM-HIGH-125 / RPT-018).
 *
 * After the persist-first flow was extracted into RegulatorySubmissionService
 * (so the interactive submit path and the retry sweep share ONE outcome
 * handler), the resolver owns exactly two responsibilities for the five REST
 * report types, locked here (sea lice as the representative — all five share
 * the same shape):
 *   - schema gate: a payload that fails the official Mattilsynet schema is
 *     rejected BEFORE any persistence — the submission service is never called
 *     and no PENDING row is created;
 *   - delegation: a schema-valid payload is handed to
 *     RegulatorySubmissionService.submitWithRecord with the correct report
 *     type + reporting period, and the submit closure calls the matching
 *     MattilsynetApiService method with the branded ValidatedPayload.
 *
 * The persist-first / classify / retry behaviour itself is covered in
 * regulatory-submission.service.spec.ts — it is not re-tested here.
 */
import { BadRequestException } from '@nestjs/common';

import { RegulatoryResolver } from '../regulatory.resolver';
import { MattilsynetApiService } from '../mattilsynet-api.service';
import { MaskinportenService } from '../maskinporten.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryVarslingService } from '../services/regulatory-varsling.service';
import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { SlaughterFacilityService } from '../services/slaughter-facility.service';
import { MattilsynetSchemaValidatorService } from '../services/mattilsynet-schema-validator.service';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import { SubmitSeaLiceReportInput } from '../dto/regulatory-inputs.dto';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER_ID = 'user-001';

function ctx(): { req: { user: { tenantId: string; sub: string } } } {
  return { req: { user: { tenantId: TENANT_ID, sub: USER_ID } } };
}

const input: SubmitSeaLiceReportInput = {
  klientReferanse: 'ref-777',
  organisasjonsnummer: '987654321',
  lokalitetsnummer: 12345,
  kontaktperson: { navn: 'Ola', epost: 'ola@farm.no', telefonnummer: '+47' },
  rapporteringsaar: 2026,
  rapporteringsuke: 26,
  sjotemperatur: 12.5,
  lusetelling: { voksneHunnlus: 0.2, bevegeligeLus: 0.4, fastsittendeLus: 0.1 },
} as SubmitSeaLiceReportInput;

describe('RegulatoryResolver — REST submit schema gate + delegation', () => {
  let resolver: RegulatoryResolver;
  let submitWithRecord: jest.Mock;
  let resubmit: jest.Mock;
  let submitSeaLice: jest.Mock;

  beforeEach(() => {
    submitSeaLice = jest.fn().mockResolvedValue({ success: true, referanse: 'MT-1' });
    // Capture the submit closure the resolver builds so we can prove it wires
    // the validated payload to the correct MattilsynetApiService method.
    submitWithRecord = jest
      .fn()
      .mockResolvedValue({ success: true, reportId: 'row-777', referanse: 'MT-1' });
    resubmit = jest
      .fn()
      .mockResolvedValue({ success: true, reportId: 'row-777', referanse: 'MT-2' });

    const mattilsynet: Pick<MattilsynetApiService, 'submitSeaLiceReport'> = {
      submitSeaLiceReport: submitSeaLice,
    };
    const submissionService: Pick<RegulatorySubmissionService, 'submitWithRecord' | 'resubmit'> = {
      submitWithRecord,
      resubmit,
    };

    // SEC-HIGH-001: the resolver verifies the client-declared identity is
    // tenant-owned before submitting. The mock owns lokalitet 12345 under org
    // 987654321 (matching the test input).
    const settingsService: Pick<
      RegulatorySettingsService,
      'getEffectiveSiteLocalityMappings' | 'getEffectiveOrganisationNumber'
    > = {
      getEffectiveSiteLocalityMappings: jest.fn().mockResolvedValue({ 'site-1': 12345 }),
      getEffectiveOrganisationNumber: jest.fn().mockResolvedValue('987654321'),
    };

    resolver = new RegulatoryResolver(
      mattilsynet as MattilsynetApiService,
      {} as MaskinportenService,
      settingsService as RegulatorySettingsService,
      {} as RegulatoryVarslingService,
      // The REAL validator (pure, no deps): the delegation path must only ever
      // hand a schema-valid payload to the submission service.
      new MattilsynetSchemaValidatorService(),
      submissionService as RegulatorySubmissionService,
      {} as SlaughterFacilityService,
    );
  });

  it('delegates a schema-valid payload to submitWithRecord with the right type + period', async () => {
    const result = await resolver.submitSeaLiceReport(input, ctx());

    expect(result.success).toBe(true);
    expect(result.reportId).toBe('row-777');
    expect(submitWithRecord).toHaveBeenCalledTimes(1);
    const call = submitWithRecord.mock.calls[0];
    expect(call[0]).toBe(TENANT_ID);
    expect(call[1]).toBe(USER_ID);
    expect(call[2]).toBe(RegulatoryReportType.SEA_LICE);
    expect(call[3]).toBe(input); // routing (klientReferanse / lokalitetsnummer)
    expect(call[4]).toEqual({ year: 2026, week: 26 });
    // The STORED payload is the validated Mattilsynet WIRE shape (Norwegian
    // field names), NOT the GraphQL input DTO — so the retry sweep replays the
    // exact bytes that crossed the trust boundary.
    expect(call[5]).toEqual(
      expect.objectContaining({
        sjøtemperatur: 12.5,
        rapporteringsår: 2026,
        lokalitetsnummer: 12345,
      }),
    );
    expect(call[6]).toEqual(expect.any(Function));
  });

  it('wires the submit closure to MattilsynetApiService with the validated payload', async () => {
    await resolver.submitSeaLiceReport(input, ctx());

    // Invoke the closure the resolver passed as the 7th argument.
    const submitClosure = submitWithRecord.mock.calls[0][6] as () => Promise<unknown>;
    await submitClosure();

    expect(submitSeaLice).toHaveBeenCalledTimes(1);
    expect(submitSeaLice).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ klientReferanse: 'ref-777', lokalitetsnummer: 12345 }),
    );
  });

  it('rejects a schema-invalid payload BEFORE delegating — no submitWithRecord, no API call', async () => {
    const invalid = {
      ...input,
      // Owned lokalitet (passes the identity gate), but the official schema caps
      // rapporteringsuke at 53 — so the schema gate rejects it.
      rapporteringsuke: 99,
    } as SubmitSeaLiceReportInput;

    const result = await resolver.submitSeaLiceReport(invalid, ctx());

    expect(result.success).toBe(false);
    expect(result.valideringsfeil).toEqual(
      expect.arrayContaining([expect.objectContaining({ felt: 'rapporteringsuke' })]),
    );
    expect(submitWithRecord).not.toHaveBeenCalled();
    expect(submitSeaLice).not.toHaveBeenCalled();
  });

  it('SEC-HIGH-001: rejects a lokalitetsnummer that is not a tenant-owned site — no submit', async () => {
    const foreign = { ...input, lokalitetsnummer: 54321 } as SubmitSeaLiceReportInput;

    await expect(resolver.submitSeaLiceReport(foreign, ctx())).rejects.toThrow(BadRequestException);
    expect(submitWithRecord).not.toHaveBeenCalled();
    expect(submitSeaLice).not.toHaveBeenCalled();
  });

  it('SEC-HIGH-001: rejects an organisasjonsnummer that does not match the tenant config — no submit', async () => {
    const foreignOrg = { ...input, organisasjonsnummer: '111111111' } as SubmitSeaLiceReportInput;

    await expect(resolver.submitSeaLiceReport(foreignOrg, ctx())).rejects.toThrow(
      BadRequestException,
    );
    expect(submitWithRecord).not.toHaveBeenCalled();
  });

  it('resubmitRegulatoryReport delegates to the submission service replay path', async () => {
    const result = await resolver.resubmitRegulatoryReport('row-777', ctx());

    expect(result.success).toBe(true);
    expect(resubmit).toHaveBeenCalledWith(TENANT_ID, 'row-777');
  });
});
