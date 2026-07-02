/**
 * REST report submissions — persist-first flow (FARM-HIGH-112).
 *
 * Locks the record-of-submission contract for the five Mattilsynet REST
 * report types (sea lice exercised as the representative — all five run
 * through the same submitWithRecord path):
 *   - the PENDING row is persisted BEFORE the Mattilsynet call;
 *   - API success   → markSubmitted with the returned referanse;
 *   - API rejection → markFailed with the validation detail, result
 *                     passed through (success=false) + reportId attached;
 *   - API throw     → markFailed with the error, NO fake-success;
 *   - a store failure fails the submit — an unrecorded report must never
 *     reach the regulator.
 */
import { RegulatoryResolver } from '../regulatory.resolver';
import { MattilsynetApiService } from '../mattilsynet-api.service';
import { MaskinportenService } from '../maskinporten.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryVarslingService } from '../services/regulatory-varsling.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import {
  RegulatoryReport,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';
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

describe('RegulatoryResolver — REST submit persist-first flow', () => {
  let resolver: RegulatoryResolver;
  let submitSeaLice: jest.Mock;
  let recordPending: jest.Mock;
  let markSubmitted: jest.Mock;
  let markFailed: jest.Mock;
  let getSettings: jest.Mock;

  beforeEach(() => {
    submitSeaLice = jest.fn();
    recordPending = jest.fn().mockImplementation(() => {
      const row = new RegulatoryReport();
      row.id = 'row-777';
      return Promise.resolve(row);
    });
    markSubmitted = jest.fn().mockResolvedValue(undefined);
    markFailed = jest.fn().mockResolvedValue(undefined);
    getSettings = jest.fn().mockResolvedValue({
      siteLocalityMappings: { 'site-1': 12345 },
    });

    const mattilsynet: Pick<MattilsynetApiService, 'submitSeaLiceReport'> = {
      submitSeaLiceReport: submitSeaLice,
    };
    const settings: Pick<RegulatorySettingsService, 'getSettings'> = { getSettings };
    const store: Pick<
      RegulatoryReportStoreService,
      'recordPending' | 'markSubmitted' | 'markFailed'
    > = {
      recordPending,
      markSubmitted,
      markFailed,
    };

    resolver = new RegulatoryResolver(
      mattilsynet as MattilsynetApiService,
      {} as MaskinportenService,
      settings as RegulatorySettingsService,
      {} as RegulatoryVarslingService,
      store as RegulatoryReportStoreService,
    );
  });

  it('persists PENDING before the API call and marks SUBMITTED on success', async () => {
    submitSeaLice.mockImplementation(() => {
      // The record must already exist when the regulator is called.
      expect(recordPending).toHaveBeenCalledTimes(1);
      return Promise.resolve({ success: true, referanse: 'MT-1', klientReferanse: 'ref-777' });
    });

    const result = await resolver.submitSeaLiceReport(input, ctx());

    expect(result.success).toBe(true);
    expect(result.reportId).toBe('row-777');
    expect(recordPending).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        reportType: RegulatoryReportType.SEA_LICE,
        klientReferanse: 'ref-777',
        siteId: 'site-1', // reverse-mapped from lokalitetsnummer 12345
        lokalitetsnummer: 12345,
        reportYear: 2026,
        reportWeek: 26,
        submittedBy: USER_ID,
      }),
    );
    expect(markSubmitted).toHaveBeenCalledWith(TENANT_ID, 'row-777', 'MT-1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED with the validation detail when Mattilsynet rejects', async () => {
    submitSeaLice.mockResolvedValue({
      success: false,
      klientReferanse: 'ref-777',
      valideringsfeil: [{ felt: 'lusetelling', melding: 'ugyldig' }],
    });

    const result = await resolver.submitSeaLiceReport(input, ctx());

    expect(result.success).toBe(false);
    expect(result.reportId).toBe('row-777');
    expect(markFailed).toHaveBeenCalledWith(TENANT_ID, 'row-777', 'lusetelling: ugyldig');
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('marks FAILED and returns an honest failure when the API throws', async () => {
    submitSeaLice.mockRejectedValue(new Error('mattilsynet 502'));

    const result = await resolver.submitSeaLiceReport(input, ctx());

    expect(result.success).toBe(false);
    expect(result.feilmelding).toBe('mattilsynet 502');
    expect(result.reportId).toBe('row-777');
    expect(markFailed).toHaveBeenCalledWith(TENANT_ID, 'row-777', 'mattilsynet 502');
  });

  it('fails the submit when the record cannot be persisted (never report unrecorded)', async () => {
    recordPending.mockRejectedValue(new Error('db down'));

    await expect(resolver.submitSeaLiceReport(input, ctx())).rejects.toThrow('db down');
    expect(submitSeaLice).not.toHaveBeenCalled();
  });
});
