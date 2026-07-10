/**
 * DiseaseReportAssembler — interim source (FARM-MEDIUM-152): the disease varsling
 * assembles from the site's latest DISEASE_OUTBREAK health event (there is no
 * disease operational entity yet). diseaseName / affectedPercentage / pathogen
 * category are RECORDS; the regulator's A/C/F list category, suspected/confirmed
 * status, affected count and vet notification stay MANUAL_REQUIRED (health events
 * cannot express them). No event blocks the whole draft (fail-closed).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { DiseaseReportAssembler } from '../../assembly/assemblers/disease.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(rows: unknown[]): DiseaseReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM health_events')) return Promise.resolve(rows);
    return Promise.resolve([]);
  });
  return new DiseaseReportAssembler(mockDataSource);
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'he-1',
  eventDate: '2026-06-14',
  title: 'Gill disease outbreak',
  diagnosis: 'Amoebic gill disease',
  pathogenCategory: 'parasitic',
  affectedPercent: '18.0',
  description: 'lethargy, flared gills',
  ...over,
});

describe('DiseaseReportAssembler', () => {
  it('surfaces diseaseName, affected percentage and pathogen category as RECORDS', async () => {
    const assembler = makeAssembler([row()]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.healthEventId).toBe('he-1');
    expect(draftPayload.diseaseName).toBe('Amoebic gill disease');
    expect(draftPayload.pathogenCategory).toBe('parasitic');
    expect(draftPayload.affectedPercentage).toBe(18);
    expect(fields.find((f) => f.path === '/diseaseName')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
    expect(fields.find((f) => f.path === '/affectedPercentage')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
  });

  it('falls back to the event title when there is no diagnosis', async () => {
    const assembler = makeAssembler([row({ diagnosis: null })]);
    const { draftPayload } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.diseaseName).toBe('Gill disease outbreak');
  });

  it('keeps the A/C/F list category, confirmation, count and vet MANUAL_REQUIRED and blocking', async () => {
    const assembler = makeAssembler([row()]);
    const { fields } = await assembler.assemble(tenantId, siteId);
    for (const path of [
      '/diseaseCategory',
      '/confirmation',
      '/affectedCount',
      '/veterinarianNotified',
    ]) {
      expect(fields.find((f) => f.path === path)).toMatchObject({
        provenance: ReportFieldProvenance.MANUAL_REQUIRED,
        blocking: true,
      });
    }
  });

  it('blocks the whole draft when the site has no disease-outbreak health event', async () => {
    const assembler = makeAssembler([]);
    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.healthEventId).toBeNull();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ path: '/', blocking: true });
  });
});
