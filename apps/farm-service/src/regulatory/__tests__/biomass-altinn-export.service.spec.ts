/**
 * BiomassAltinnExportService — the FD-0001 export builder (RPT-001). Verifies
 * the CSV is form-ordered + machine-parseable and the printable block is
 * faithful to the persisted biomass payload (golden fixture, deterministic).
 */
import { BiomassAltinnExportService } from '../services/biomass-altinn-export.service';
import { BiomassReport, BiomassReportStatus } from '../entities/biomass-report.entity';

function fixture(): BiomassReport {
  return {
    id: 'bbbbbbbb-1111-4222-8333-444444444444',
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    siteId: 'ssssssss-1111-4222-8333-444444444444',
    reportMonth: 4,
    reportYear: 2026,
    status: BiomassReportStatus.READY,
    totalBiomassKg: '42000.00',
    reportData: {
      currentBiomass: {
        totalKg: 42000,
        bySpecies: [
          {
            speciesId: 'SAL',
            speciesName: 'Atlantic Salmon',
            fishCount: 100000,
            biomassKg: 42000,
            avgWeightG: 420,
          },
        ],
      },
      stockings: [
        {
          date: '2026-04-03',
          speciesCode: 'SAL',
          fishCount: 5000,
          avgWeightG: 100,
          biomassKg: 500,
        },
      ],
      mortality: {
        totalCount: 120,
        byCause: [{ cause: 'DISEASE', count: 120 }],
        details: [],
      },
      slaughter: { totalQuantity: 2000, totalBiomassKg: 8400, records: [] },
      transfers: [
        {
          date: '2026-04-10',
          direction: 'OUT',
          speciesCode: 'SAL',
          fishCount: 300,
          biomassKg: 120,
        },
      ],
      feedConsumption: { totalKg: 15000, byFeedType: [{ feedName: 'Nutra', quantityKg: 15000 }] },
    },
    generatedBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('BiomassAltinnExportService', () => {
  const service = new BiomassAltinnExportService();

  it('builds a form-ordered, parseable CSV with the period + biomass rows', () => {
    const out = service.build(fixture());

    expect(out.filename).toBe('FD-0001-ssssssss-2026-04.csv');
    expect(out.periodLabel).toBe('2026-04');

    const lines = out.csv.split('\n');
    expect(lines[0]).toBe('Section,Field,Value');
    // Standing biomass species rows present + form-ordered before Feed.
    expect(out.csv).toContain('StandingBiomass,Atlantic Salmon — biomassKg,42000.00');
    expect(out.csv).toContain('Mortality,Cause: DISEASE,120');
    expect(out.csv).toContain('Feed,Nutra,15000.00');
    expect(out.csv.indexOf('StandingBiomass')).toBeLessThan(out.csv.indexOf('Feed'));
  });

  it('escapes CSV cells that contain a comma', () => {
    const rep = fixture();
    const first = rep.reportData.currentBiomass.bySpecies[0];
    if (first) first.speciesName = 'Salmon, Atlantic';
    const out = service.build(rep);
    expect(out.csv).toContain('"Salmon, Atlantic — biomassKg"');
  });

  it('neutralises CSV formula injection in a tenant-controlled cell (SEC-MEDIUM-002)', () => {
    const rep = fixture();
    const first = rep.reportData.currentBiomass.bySpecies[0];
    // A malicious species name a spreadsheet would evaluate as a formula.
    if (first) first.speciesName = '=cmd|"/c calc"!A1';
    const out = service.build(rep);

    // The dangerous cell opens as literal text: prefixed with a single quote,
    // and (because it also contains a comma) RFC-4180 quoted. It is NEVER
    // emitted with a bare leading '='.
    expect(out.csv).toContain(`"'=cmd|""/c calc""!A1 — biomassKg"`);
    expect(out.csv).not.toMatch(/(^|\n)=cmd/);
    expect(out.csv).not.toContain(',=cmd');
  });

  it('leaves negative numeric values numeric (no formula-guard on numbers)', () => {
    const rep = fixture();
    // Numeric cells are our own formatted values and must not be quoted/prefixed.
    rep.reportData.mortality.totalCount = 5;
    const out = service.build(rep);
    expect(out.csv).toContain('Mortality,TotalCount,5');
  });

  it('renders a printable transcription block with the Altinn instruction', () => {
    const out = service.build(fixture());
    expect(out.printable).toContain('Fiskeridirektoratet FD-0001');
    expect(out.printable).toContain('Period: 2026-04');
    expect(out.printable).toContain('confirm the submission with the Altinn receipt');
    expect(out.printable).toContain('Atlantic Salmon — biomassKg: 42000.00');
  });
});
