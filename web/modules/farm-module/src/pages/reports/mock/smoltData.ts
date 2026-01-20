/**
 * Smolt Report Mock Data
 * Monthly settefisk reports (due 7th of each month)
 *
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 * Endpoint: POST /api/settefisk/v1/settefisk
 */

import {
  SmoltReport,
  ReportStatus,
  TransferRecord,
  ProduksjonsenhetSettefisk,
  Kontaktperson,
} from '../types/reports.types';

// Default contact person for mock data
const defaultKontaktperson: Kontaktperson = {
  navn: 'Anna Larsen',
  epost: 'anna.larsen@bergen-smolt.no',
  telefonnummer: '+4791122334',
};

const now = new Date();
const currentMonth = now.getMonth();
const currentYear = now.getFullYear();

// Calculate deadline (7th of month)
function getDeadline(month: number, year: number): Date {
  return new Date(year, month, 7, 23, 59, 59, 999);
}

// Get previous month info
const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
const twoMonthsAgo = currentMonth <= 1 ? currentMonth + 10 : currentMonth - 2;
const twoMonthsAgoYear = currentMonth <= 1 ? currentYear - 1 : currentYear;

export const mockSmoltReports: SmoltReport[] = [
  // Current month - draft
  {
    id: 'smo-2026-01',
    siteId: 'smolt-001',
    siteName: 'Bergen Smolt AS',
    reportType: 'smolt',
    status: 'draft',

    // API-aligned fields
    rapporteringsmaaned: currentMonth + 1,  // 1-indexed for API
    rapporteringsaar: currentYear,
    klientReferanse: `SMO-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-001`,
    organisasjonsnummer: '999888777',
    lokalitetsnummer: 55123,  // NUMBER not string
    kontaktperson: defaultKontaktperson,

    // Production units - empty for draft
    produksjonsenheter: [],

    // Legacy fields for UI
    month: currentMonth,
    year: currentYear,
    deadline: getDeadline(currentMonth + 1, currentYear),
    createdAt: new Date(currentYear, currentMonth, 1),
    updatedAt: now,
    facilityType: 'land_based',
    fishCounts: {
      byUnit: [],
      total: 0,
    },
    averageWeights: {
      overall: 0,
      byStage: [],
    },
    mortalityRates: {
      overall: 0,
      byUnit: [],
    },
    transfers: {
      outgoing: [],
    },
  },

  // Previous month - submitted and approved
  {
    id: 'smo-2025-12',
    siteId: 'smolt-001',
    siteName: 'Bergen Smolt AS',
    reportType: 'smolt',
    status: 'approved',

    // API-aligned fields
    rapporteringsmaaned: prevMonth + 1,  // 1-indexed for API
    rapporteringsaar: prevMonthYear,
    klientReferanse: 'SMO-2025-12-001',
    organisasjonsnummer: '999888777',
    lokalitetsnummer: 55123,  // NUMBER not string
    kontaktperson: defaultKontaktperson,

    // Production units - ALIGNED WITH API
    produksjonsenheter: [
      {
        karId: 'tank-a1',
        artskode: 'SAL',  // Atlantic Salmon
        snittvektGram: 45,
        beholdningVedMaanedsslutt: 85000,
        antallAvlivet: 285,
        antallSelvdod: 500,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-a2',
        artskode: 'SAL',
        snittvektGram: 48,
        beholdningVedMaanedsslutt: 82000,
        antallAvlivet: 250,
        antallSelvdod: 475,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-b1',
        artskode: 'SAL',
        snittvektGram: 85,
        beholdningVedMaanedsslutt: 65000,
        antallAvlivet: 185,
        antallSelvdod: 350,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-b2',
        artskode: 'SAL',
        snittvektGram: 92,
        beholdningVedMaanedsslutt: 62000,
        antallAvlivet: 165,
        antallSelvdod: 320,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-c1',
        artskode: 'SAL',
        snittvektGram: 120,
        beholdningVedMaanedsslutt: 45000,
        antallAvlivet: 100,
        antallSelvdod: 225,
        antallFlyttetEksternt: 15000,  // Transferred to sea farm
      },
      {
        karId: 'tank-c2',
        artskode: 'SAL',
        snittvektGram: 125,
        beholdningVedMaanedsslutt: 42000,
        antallAvlivet: 115,
        antallSelvdod: 270,
        antallFlyttetEksternt: 12000,  // Transferred to sea farm
      },
    ],

    // Legacy fields for UI
    month: prevMonth,
    year: prevMonthYear,
    deadline: getDeadline(prevMonth + 1, prevMonthYear),
    createdAt: new Date(prevMonthYear, prevMonth, 1),
    updatedAt: new Date(currentYear, currentMonth, 4),
    submittedAt: new Date(currentYear, currentMonth, 4),
    submittedBy: 'Anna Larsen',
    facilityType: 'land_based',
    fishCounts: {
      byUnit: [
        {
          unitId: 'tank-a1',
          unitName: 'Tank A1',
          unitType: 'tank',
          quantity: 85000,
          avgWeightG: 45,
          stage: 'fry',
        },
        {
          unitId: 'tank-a2',
          unitName: 'Tank A2',
          unitType: 'tank',
          quantity: 82000,
          avgWeightG: 48,
          stage: 'fry',
        },
        {
          unitId: 'tank-b1',
          unitName: 'Tank B1',
          unitType: 'tank',
          quantity: 65000,
          avgWeightG: 85,
          stage: 'parr',
        },
        {
          unitId: 'tank-b2',
          unitName: 'Tank B2',
          unitType: 'tank',
          quantity: 62000,
          avgWeightG: 92,
          stage: 'parr',
        },
        {
          unitId: 'tank-c1',
          unitName: 'Tank C1',
          unitType: 'tank',
          quantity: 45000,
          avgWeightG: 120,
          stage: 'smolt',
        },
        {
          unitId: 'tank-c2',
          unitName: 'Tank C2',
          unitType: 'tank',
          quantity: 42000,
          avgWeightG: 125,
          stage: 'smolt',
        },
      ],
      total: 381000,
    },
    averageWeights: {
      overall: 82.5,
      byStage: [
        { stage: 'fry', avgWeightG: 46.5, quantity: 167000 },
        { stage: 'parr', avgWeightG: 88.5, quantity: 127000 },
        { stage: 'smolt', avgWeightG: 122.5, quantity: 87000 },
      ],
    },
    mortalityRates: {
      overall: 0.85,
      byUnit: [
        { unitId: 'tank-a1', unitName: 'Tank A1', rate: 0.92, count: 785 },
        { unitId: 'tank-a2', unitName: 'Tank A2', rate: 0.88, count: 725 },
        { unitId: 'tank-b1', unitName: 'Tank B1', rate: 0.82, count: 535 },
        { unitId: 'tank-b2', unitName: 'Tank B2', rate: 0.78, count: 485 },
        { unitId: 'tank-c1', unitName: 'Tank C1', rate: 0.72, count: 325 },
        { unitId: 'tank-c2', unitName: 'Tank C2', rate: 0.88, count: 385 },
      ],
    },
    transfers: {
      outgoing: [
        {
          id: 'trans-smo-001',
          date: new Date(prevMonthYear, prevMonth, 5),
          toSite: 'Nordfjord Salmon Farm',
          quantity: 15000,
          biomassKg: 1800,
          batchNumber: 'SMO-2025-045',
          reason: 'Smolt delivery',
        },
        {
          id: 'trans-smo-002',
          date: new Date(prevMonthYear, prevMonth, 18),
          toSite: 'Sognefjord Aqua',
          quantity: 12000,
          biomassKg: 1500,
          batchNumber: 'SMO-2025-046',
          reason: 'Smolt delivery',
        },
      ],
    },
  },

  // 2 months ago - approved
  {
    id: 'smo-2025-11',
    siteId: 'smolt-001',
    siteName: 'Bergen Smolt AS',
    reportType: 'smolt',
    status: 'approved',

    // API-aligned fields
    rapporteringsmaaned: twoMonthsAgo + 1,
    rapporteringsaar: twoMonthsAgoYear,
    klientReferanse: 'SMO-2025-11-001',
    organisasjonsnummer: '999888777',
    lokalitetsnummer: 55123,
    kontaktperson: defaultKontaktperson,

    // Production units - ALIGNED WITH API
    produksjonsenheter: [
      {
        karId: 'tank-a1',
        artskode: 'SAL',
        snittvektGram: 32,
        beholdningVedMaanedsslutt: 88000,
        antallAvlivet: 250,
        antallSelvdod: 500,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-a2',
        artskode: 'SAL',
        snittvektGram: 35,
        beholdningVedMaanedsslutt: 85000,
        antallAvlivet: 230,
        antallSelvdod: 470,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-b1',
        artskode: 'SAL',
        snittvektGram: 72,
        beholdningVedMaanedsslutt: 68000,
        antallAvlivet: 165,
        antallSelvdod: 350,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-b2',
        artskode: 'SAL',
        snittvektGram: 78,
        beholdningVedMaanedsslutt: 65000,
        antallAvlivet: 150,
        antallSelvdod: 320,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-c1',
        artskode: 'SAL',
        snittvektGram: 105,
        beholdningVedMaanedsslutt: 52000,
        antallAvlivet: 105,
        antallSelvdod: 250,
        antallFlyttetEksternt: 0,
      },
      {
        karId: 'tank-c2',
        artskode: 'SAL',
        snittvektGram: 108,
        beholdningVedMaanedsslutt: 50000,
        antallAvlivet: 115,
        antallSelvdod: 280,
        antallFlyttetEksternt: 0,
      },
    ],

    // Legacy fields for UI
    month: twoMonthsAgo,
    year: twoMonthsAgoYear,
    deadline: getDeadline(twoMonthsAgo + 1, twoMonthsAgoYear),
    createdAt: new Date(twoMonthsAgoYear, twoMonthsAgo, 1),
    updatedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 5),
    submittedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 5),
    submittedBy: 'Anna Larsen',
    facilityType: 'land_based',
    fishCounts: {
      byUnit: [
        {
          unitId: 'tank-a1',
          unitName: 'Tank A1',
          unitType: 'tank',
          quantity: 88000,
          avgWeightG: 32,
          stage: 'fry',
        },
        {
          unitId: 'tank-a2',
          unitName: 'Tank A2',
          unitType: 'tank',
          quantity: 85000,
          avgWeightG: 35,
          stage: 'fry',
        },
        {
          unitId: 'tank-b1',
          unitName: 'Tank B1',
          unitType: 'tank',
          quantity: 68000,
          avgWeightG: 72,
          stage: 'parr',
        },
        {
          unitId: 'tank-b2',
          unitName: 'Tank B2',
          unitType: 'tank',
          quantity: 65000,
          avgWeightG: 78,
          stage: 'parr',
        },
        {
          unitId: 'tank-c1',
          unitName: 'Tank C1',
          unitType: 'tank',
          quantity: 52000,
          avgWeightG: 105,
          stage: 'smolt',
        },
        {
          unitId: 'tank-c2',
          unitName: 'Tank C2',
          unitType: 'tank',
          quantity: 50000,
          avgWeightG: 108,
          stage: 'smolt',
        },
      ],
      total: 408000,
    },
    averageWeights: {
      overall: 68.3,
      byStage: [
        { stage: 'fry', avgWeightG: 33.5, quantity: 173000 },
        { stage: 'parr', avgWeightG: 75, quantity: 133000 },
        { stage: 'smolt', avgWeightG: 106.5, quantity: 102000 },
      ],
    },
    mortalityRates: {
      overall: 0.78,
      byUnit: [
        { unitId: 'tank-a1', unitName: 'Tank A1', rate: 0.85, count: 750 },
        { unitId: 'tank-a2', unitName: 'Tank A2', rate: 0.82, count: 700 },
        { unitId: 'tank-b1', unitName: 'Tank B1', rate: 0.75, count: 515 },
        { unitId: 'tank-b2', unitName: 'Tank B2', rate: 0.72, count: 470 },
        { unitId: 'tank-c1', unitName: 'Tank C1', rate: 0.68, count: 355 },
        { unitId: 'tank-c2', unitName: 'Tank C2', rate: 0.78, count: 395 },
      ],
    },
    transfers: {
      outgoing: [],
    },
  },

  // Different facility - freshwater type, pending
  {
    id: 'smo-2026-01-fw',
    siteId: 'smolt-002',
    siteName: 'Hardanger Settefisk',
    reportType: 'smolt',
    status: 'pending',

    // API-aligned fields
    rapporteringsmaaned: currentMonth + 1,
    rapporteringsaar: currentYear,
    klientReferanse: `SMO-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-002`,
    organisasjonsnummer: '888777666',
    lokalitetsnummer: 66789,  // NUMBER not string
    kontaktperson: {
      navn: 'Per Olsen',
      epost: 'per.olsen@hardanger-settefisk.no',
      telefonnummer: '+4795544332',
    },

    // Production units - empty for pending
    produksjonsenheter: [],

    // Legacy fields for UI
    month: currentMonth,
    year: currentYear,
    deadline: getDeadline(currentMonth + 1, currentYear),
    createdAt: new Date(currentYear, currentMonth, 1),
    updatedAt: now,
    facilityType: 'freshwater',
    fishCounts: {
      byUnit: [],
      total: 0,
    },
    averageWeights: {
      overall: 0,
      byStage: [],
    },
    mortalityRates: {
      overall: 0,
      byUnit: [],
    },
    transfers: {
      outgoing: [],
    },
  },
];

/**
 * Get smolt reports by status
 */
export function getSmoltReportsByStatus(status: ReportStatus): SmoltReport[] {
  return mockSmoltReports.filter((report) => report.status === status);
}

/**
 * Get smolt reports by site
 */
export function getSmoltReportsBySite(siteId: string): SmoltReport[] {
  return mockSmoltReports.filter((report) => report.siteId === siteId);
}

/**
 * Get smolt reports by facility type
 */
export function getSmoltReportsByFacilityType(
  facilityType: 'freshwater' | 'land_based'
): SmoltReport[] {
  return mockSmoltReports.filter((report) => report.facilityType === facilityType);
}

/**
 * Get pending smolt reports
 */
export function getPendingSmoltReports(): SmoltReport[] {
  return mockSmoltReports.filter(
    (report) => report.status === 'pending' || report.status === 'draft' || report.status === 'overdue'
  );
}

/**
 * Get the latest report for a site
 */
export function getLatestSmoltReport(siteId: string): SmoltReport | undefined {
  return mockSmoltReports
    .filter((report) => report.siteId === siteId)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    })[0];
}

/**
 * Calculate total transfers for a period
 */
export function calculateTransferSummary(report: SmoltReport): {
  totalQuantity: number;
  totalBiomassKg: number;
  destinationCount: number;
} {
  const transfers = report.transfers?.outgoing || [];
  return {
    totalQuantity: transfers.reduce((sum, t) => sum + t.quantity, 0),
    totalBiomassKg: transfers.reduce((sum, t) => sum + t.biomassKg, 0),
    destinationCount: new Set(transfers.map((t) => t.toSite)).size,
  };
}
