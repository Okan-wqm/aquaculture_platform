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

function makeAssembler(rows: unknown[]): { assembler: DiseaseReportAssembler; sql: () => string } {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  let captured = '';
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM health_events')) {
      captured = sql;
      return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  });
  return { assembler: new DiseaseReportAssembler(mockDataSource), sql: () => captured };
}

// Fixture keys mirror the REAL column aliases the query returns (diseaseName from
// the diseaseName column, affectedPercent from the affectedPopulation jsonb) — not
// the phantom `diagnosis`/top-level `affectedPercent` that a mocked query once hid.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'he-1',
  eventDate: '2026-06-14',
  title: 'Gill disease outbreak',
  diseaseName: 'Amoebic gill disease',
  pathogenCategory: 'parasitic',
  affectedPercent: '18.0',
  description: 'lethargy, flared gills',
  ...over,
});

describe('DiseaseReportAssembler', () => {
  it('surfaces diseaseName, affected percentage and pathogen category as RECORDS', async () => {
    const { assembler } = makeAssembler([row()]);

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

  it('falls back to the event title when the diseaseName is unset', async () => {
    const { assembler } = makeAssembler([row({ diseaseName: null })]);
    const { draftPayload } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.diseaseName).toBe('Gill disease outbreak');
  });

  it('reads only real columns, scopes the site through real tank_batches columns, and excludes terminal outbreaks', async () => {
    // Guards the exact drift a mocked query hid: the phantom `he.diagnosis`,
    // top-level `he."affectedPercent"`, and `tank_batches.batchId` (which does not
    // exist — the real columns are primaryBatchId + the batchDetails jsonb) must
    // never come back, an INNER JOIN on the nullable he.tankId must not scope the
    // site, and a resolved/cancelled outbreak must not be surfaced for a
    // legally-immediate varsling.
    const { assembler, sql } = makeAssembler([row()]);
    await assembler.assemble(tenantId, siteId);
    const text = sql();
    expect(text).toContain('"diseaseName"');
    expect(text).toContain(`"affectedPopulation" ->> 'affectedPercent'`);
    expect(text).toContain('EXISTS');
    expect(text).toContain('tank_batches');
    // site scope uses the REAL tank_batches columns (mirrors biomass queryStockings)
    expect(text).toContain('tb."primaryBatchId" = he."batchId"');
    expect(text).toContain('tb."batchDetails"');
    expect(text).toContain(`bd->>'batchId' = he."batchId"::text`);
    // terminal outbreaks are excluded
    expect(text).toContain(`he.status NOT IN ('resolved', 'cancelled')`);
    expect(text).toContain('ORDER BY he."eventDate" DESC, he."createdAt" DESC');
    // phantom / non-existent identifiers must never come back
    expect(text).not.toContain('he.diagnosis');
    expect(text).not.toContain('he."affectedPercent"');
    expect(text).not.toContain('tb."batchId" = he."batchId"');
    expect(text).not.toContain('JOIN tanks t ON t.id = he."tankId"');
  });

  it('keeps the A/C/F list category, confirmation, count and vet MANUAL_REQUIRED and blocking', async () => {
    const { assembler } = makeAssembler([row()]);
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
    const { assembler } = makeAssembler([]);
    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.healthEventId).toBeNull();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ path: '/', blocking: true });
  });
});
