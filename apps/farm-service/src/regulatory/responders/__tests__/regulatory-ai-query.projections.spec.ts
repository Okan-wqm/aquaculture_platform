/**
 * Projection spec for the regulatory farm-AI responder (PR-4): PII deep ban,
 * ISO dates, cap/truncated, null-safety.
 */
import {
  projectBiomassReport,
  projectRegulatoryReport,
} from '../projections';
import { BiomassReport } from '../../entities/biomass-report.entity';
import { RegulatoryReport } from '../../entities/regulatory-report.entity';

const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'generatedBy',
  'submittedBy',
  'confirmedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'supplier',
  'buyer',
  'payload',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const REPORT: BiomassReport = {
  id: 'br1',
  tenantId: 't',
  siteId: 's1',
  reportMonth: 8,
  reportYear: 2026,
  status: 'submitted',
  reportData: {
    currentBiomass: {
      totalKg: 12000,
      bySpecies: [{ speciesId: 'sp1', speciesName: 'Seabass', fishCount: 9000, biomassKg: 12000, avgWeightG: 380 }],
    },
    stockings: [
      { date: '2026-02-01', speciesCode: 'SEABASS', supplier: 'Supplier AS', fishCount: 10000, avgWeightG: 50, biomassKg: 500, notes: 'note' },
    ],
    mortality: {
      totalCount: 480,
      byCause: [{ cause: 'predation', count: 480 }],
      details: [{ date: '2026-03-01', cause: 'predation', speciesCode: 'SEABASS', count: 480, notes: 'note' }],
    },
    slaughter: {
      totalQuantity: 500,
      totalBiomassKg: 200,
      records: [{ date: '2026-08-15', speciesCode: 'SEABASS', quantity: 500, biomassKg: 200, buyer: 'Buyer AS', notes: 'note' }],
    },
    transfers: [
      { date: '2026-04-01', direction: 'OUT', speciesCode: 'SEABASS', fishCount: 200, biomassKg: 80, counterparty: 'Site B', notes: 'note' },
    ],
    feedConsumption: {
      totalKg: 3900,
      byFeedType: [{ feedName: 'Grower 3mm', brandName: 'Skretting', quantityKg: 3900 }],
    },
  } as BiomassReport['reportData'],
  totalBiomassKg: '12000.00' as unknown as number,
  generatedBy: 'user-id',
  submittedAt: new Date('2026-09-01T06:00:00.000Z'),
  submittedBy: 'user-id',
  readyAt: null,
  confirmedBy: 'user-id',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as BiomassReport;

describe('regulatory farm-AI projections (PR-4 read-only namespace)', () => {
  it('strips submitter identity, payload blob and payload free-text — deep key scan', () => {
    const report = projectBiomassReport(REPORT);
    expect(report).not.toBeNull();
    const keys = collectKeys(report);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
    }

    const row = projectRegulatoryReport({
      id: 'rr1',
      tenantId: 't',
      reportType: 'SEA_LICE',
      klientReferanse: 'ref-1',
      siteId: 's1',
      lokalitetsnummer: 12345,
      reportYear: 2026,
      reportWeek: 33,
      reportMonth: null,
      status: 'SUBMITTED',
      payload: { form: 'secret' } as unknown as RegulatoryReport['payload'],
      referanse: 'MM-1',
      submittedBy: 'user-id',
      submittedAt: new Date(),
      attemptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as RegulatoryReport);
    const rowKeys = collectKeys(row);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: rowKeys.has(banned) }).toEqual({ banned, present: false });
    }
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('projects null when the report is absent', () => {
    expect(projectBiomassReport(null)).toBeNull();
  });

  it('serializes dates as ISO and coerces the decimal string', () => {
    const report = projectBiomassReport(REPORT);
    expect(report?.submittedAt).toBe('2026-09-01T06:00:00.000Z');
    expect(report?.readyAt).toBeNull();
    expect(report?.totalBiomassKg).toBe(12000);
    expect(report?.transfers[0]?.date).toBe('2026-04-01');
  });

  it('caps payload detail lists at 50 and flags truncation', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      date: '2026-03-01',
      cause: 'predation',
      speciesCode: 'SEABASS',
      count: i,
    }));
    const report = projectBiomassReport({
      ...REPORT,
      reportData: {
        ...REPORT.reportData,
        mortality: { totalCount: 80, byCause: [], details: many },
      } as BiomassReport['reportData'],
    });
    expect(report?.mortality.details).toHaveLength(50);
  });
});
