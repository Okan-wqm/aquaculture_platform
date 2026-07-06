/**
 * LakselusReportAssembler — temperature from the ONE WaterTemperatureService
 * PERIOD path (aggregated over the report week, RECORDS provenance);
 * lusetelling from lice_counts (weekly fishSampled-weighted mean, blocking
 * only when the week has no counts); behandlinger from treatment_applications
 * in the official vocabulary with fail-closed handling of unclassifiable
 * legacy rows.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { LakselusReportAssembler } from '../../assembly/assemblers/lakselus.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(options: {
  temperature: Awaited<ReturnType<WaterTemperatureService['getPeriodTemperature']>>;
  liceCounts?: unknown[];
  treatments?: unknown[];
}): LakselusReportAssembler {
  const service: Pick<WaterTemperatureService, 'getPeriodTemperature'> = {
    getPeriodTemperature: jest.fn().mockResolvedValue(options.temperature),
  };
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM lice_counts')) return Promise.resolve(options.liceCounts ?? []);
    if (sql.includes('FROM treatment_applications')) {
      return Promise.resolve(options.treatments ?? []);
    }
    return Promise.resolve([]);
  });
  return new LakselusReportAssembler(service as WaterTemperatureService, mockDataSource);
}

describe('LakselusReportAssembler', () => {
  it('uses the report-week period temperature with RECORDS provenance + coverage', async () => {
    const assembler = makeAssembler({
      temperature: { celsius: 12.4, source: 'sensor', coverageDays: 6, minC: 11.8, maxC: 13.1 },
    });

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.sjøtemperatur).toBe(12.4);
    const meta = fields.find((f) => f.path === '/sjøtemperatur');
    expect(meta).toMatchObject({
      provenance: ReportFieldProvenance.RECORDS,
      sourceRecordCount: 6,
      blocking: false,
    });
    expect(meta?.sourceQuery).toContain('sensor');
  });

  it('uses the manual period fallback with RECORDS provenance', async () => {
    const assembler = makeAssembler({
      temperature: { celsius: 11.0, source: 'manual', coverageDays: 2, minC: 10.5, maxC: 11.5 },
    });

    const { fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    const meta = fields.find((f) => f.path === '/sjøtemperatur');
    expect(meta?.provenance).toBe(ReportFieldProvenance.RECORDS);
    expect(meta?.sourceQuery).toContain('manual');
  });

  it('aggregates the week lice counts as a fishSampled-weighted mean (RECORDS)', async () => {
    const assembler = makeAssembler({
      temperature: null,
      liceCounts: [
        // 20 fish at 0.5 + 10 fish at 2.0 → (10 + 20) / 30 = 1.0
        {
          adultFemaleLice: '0.5',
          mobileLice: '1.0',
          attachedLice: '0.0',
          fishSampled: '20',
          countDate: '2026-06-29',
        },
        {
          adultFemaleLice: '2.0',
          mobileLice: '4.0',
          attachedLice: '3.0',
          fishSampled: '10',
          countDate: '2026-07-01',
        },
      ],
    });

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.lusetelling).toEqual({
      voksneHunnlus: 1.0,
      bevegeligeLus: 2.0,
      fastsittendeLus: 1.0,
    });
    const meta = fields.find((f) => f.path === '/lusetelling');
    expect(meta).toMatchObject({
      provenance: ReportFieldProvenance.RECORDS,
      sourceRecordCount: 2,
      blocking: false,
    });
  });

  it('blocks on missing temperature AND on a count-less week (no guessing)', async () => {
    const assembler = makeAssembler({ temperature: null });

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.sjøtemperatur).toBeNull();
    const temperature = fields.find((f) => f.path === '/sjøtemperatur');
    expect(temperature?.provenance).toBe(ReportFieldProvenance.MANUAL_REQUIRED);
    expect(temperature?.blocking).toBe(true);

    const counting = fields.find((f) => f.path === '/lusetelling');
    expect(counting?.provenance).toBe(ReportFieldProvenance.MANUAL_REQUIRED);
    expect(counting?.blocking).toBe(true);
    expect(draftPayload.lusetelling).toEqual({
      voksneHunnlus: 0,
      bevegeligeLus: 0,
      fastsittendeLus: 0,
    });
  });

  it('emits treatments in the official vocabulary with gjennomførtFørTelling derived from count timing', async () => {
    const assembler = makeAssembler({
      temperature: null,
      liceCounts: [
        {
          adultFemaleLice: '0.2',
          mobileLice: '0.4',
          attachedLice: '0.1',
          fishSampled: '20',
          countDate: '2026-07-01',
        },
      ],
      treatments: [
        {
          id: 't-1',
          category: 'non_medicinal',
          method: 'TERMISK_BEHANDLING',
          virkestoffType: null,
          styrkeVerdi: null,
          styrkeEnhet: null,
          mengdeVerdi: null,
          mengdeEnhet: null,
          wholeSite: false,
          pensCount: 3,
          appliedAt: new Date('2026-06-30T08:00:00Z'),
          beskrivelse: null,
        },
        {
          id: 't-2',
          category: 'medicinal',
          method: 'BADEBEHANDLING',
          virkestoffType: 'AZAMETHIPHOS',
          styrkeVerdi: '0.5',
          styrkeEnhet: 'PROSENT',
          mengdeVerdi: '120',
          mengdeEnhet: 'LITER',
          wholeSite: true,
          pensCount: null,
          appliedAt: new Date('2026-07-03T08:00:00Z'),
          beskrivelse: null,
        },
      ],
    });

    const { draftPayload } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.ikkeMedikamentelleBehandlinger).toEqual([
      {
        type: 'TERMISK_BEHANDLING',
        gjennomførtFørTelling: true,
        heleLokaliteten: false,
        antallMerder: 3,
        beskrivelse: undefined,
      },
    ]);
    expect(draftPayload.medikamentelleBehandlinger).toEqual([
      {
        type: 'BADEBEHANDLING',
        // Applied after the week's latest count → not before counting.
        gjennomførtFørTelling: false,
        heleLokaliteten: true,
        antallMerder: undefined,
        virkestoff: {
          type: 'AZAMETHIPHOS',
          styrke: { verdi: 0.5, enhet: 'PROSENT' },
          mengde: { verdi: 120, enhet: 'LITER' },
          annetVirkestoff: undefined,
        },
        beskrivelse: undefined,
      },
    ]);
  });

  it('fail-closes an unclassifiable legacy medicinal row instead of coercing it', async () => {
    const assembler = makeAssembler({
      temperature: null,
      treatments: [
        {
          id: 'legacy-1',
          category: 'medicinal',
          method: 'BADEBEHANDLING',
          virkestoffType: null,
          styrkeVerdi: null,
          styrkeEnhet: null,
          mengdeVerdi: null,
          mengdeEnhet: null,
          wholeSite: false,
          pensCount: null,
          appliedAt: new Date('2026-07-02T08:00:00Z'),
          beskrivelse: 'Salmosan — azametifos',
        },
      ],
    });

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.medikamentelleBehandlinger).toEqual([]);
    const blocker = fields.find((f) => f.path === '/medikamentelleBehandlinger' && f.blocking);
    expect(blocker?.message).toContain('legacy-1');
  });
});
