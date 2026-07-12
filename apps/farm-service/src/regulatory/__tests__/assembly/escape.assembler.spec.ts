/**
 * EscapeReportAssembler — the rømming varsling assembles from the latest OPEN,
 * unreported escape_incident (RECORDS provenance); a missing incident, missing
 * weight, or unmapped species is a blocking MANUAL_REQUIRED (fail-closed —
 * corrections flow to the incident record, never the report).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { EscapeReportAssembler } from '../../assembly/assemblers/escape.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(rows: unknown[]): EscapeReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM escape_incidents')) return Promise.resolve(rows);
    return Promise.resolve([]);
  });
  return new EscapeReportAssembler(mockDataSource);
}

const fullRow = {
  id: 'inc-1',
  detectedAt: new Date('2026-06-10T08:30:00.000Z'),
  estimatedCount: 1200,
  avgWeightG: '4200.0',
  cause: 'hole_in_net',
  causeDetails: 'tear on north wall',
  recoveryOngoing: true,
  tankCode: 'MERD-07',
  artskode: 'SAL',
};

describe('EscapeReportAssembler', () => {
  it('assembles a full incident as RECORDS and derives escaped biomass', async () => {
    const assembler = makeAssembler([fullRow]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.incidentId).toBe('inc-1');
    expect(draftPayload.estimatedCount).toBe(1200);
    expect(draftPayload.species).toBe('SAL');
    expect(draftPayload.avgWeightG).toBe(4200);
    // 1200 fish × 4200 g / 1000 = 5040 kg
    expect(draftPayload.totalBiomassKg).toBe(5040);
    expect(draftPayload.affectedUnits).toEqual(['MERD-07']);
    expect(draftPayload.recoveryOngoing).toBe(true);

    // No blocking fields — a fully-recorded incident is submission-ready.
    expect(fields.every((f) => !f.blocking)).toBe(true);
    expect(fields.find((f) => f.path === '/estimatedCount')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
  });

  it('blocks the whole draft when the site has no open, unreported incident', async () => {
    const assembler = makeAssembler([]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.incidentId).toBeNull();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      path: '/',
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
  });

  it('blocks weight + biomass when the incident has no average weight', async () => {
    const assembler = makeAssembler([{ ...fullRow, avgWeightG: null }]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.avgWeightG).toBeNull();
    expect(draftPayload.totalBiomassKg).toBeNull();
    expect(fields.find((f) => f.path === '/avgWeightG')).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
    expect(fields.find((f) => f.path === '/totalBiomassKg')?.blocking).toBe(true);
  });

  it('blocks species when the escaped species has no official FAO code', async () => {
    const assembler = makeAssembler([{ ...fullRow, artskode: null }]);

    const { fields } = await assembler.assemble(tenantId, siteId);

    expect(fields.find((f) => f.path === '/species')).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
  });

  it('flags affected units as non-blocking manual for a whole-site (untanked) escape', async () => {
    const assembler = makeAssembler([{ ...fullRow, tankCode: null }]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.affectedUnits).toEqual([]);
    expect(fields.find((f) => f.path === '/affectedUnits')).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: false,
    });
  });
});
