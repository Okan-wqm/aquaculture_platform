/**
 * Sea Lice Report Mock Data
 * Weekly lakselus reports (due every Tuesday)
 *
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 * Endpoint: POST /api/lakselus/v1/lakselus
 */

import {
  SeaLiceReport,
  ReportStatus,
  SeaLiceCounts,
  SeaLiceCageCount,
  CleanerFishEntry,
  SeaLiceTreatment,
  SensitivityTest,
  Lusetelling,
  IkkeMedikamentellBehandling,
  MedikamentellBehandling,
  Folsomhetsundersokelse,
  Kontaktperson,
} from '../types/reports.types';
import { SEA_LICE_THRESHOLDS } from '../utils/thresholds';

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

// Calculate dates for weekly reports
function getWeekStart(weekOffset: number): Date {
  const date = new Date(today);
  date.setDate(date.getDate() - date.getDay() + 1 + weekOffset * 7); // Monday
  return date;
}

function getDeadline(weekOffset: number): Date {
  const date = getWeekStart(weekOffset);
  date.setDate(date.getDate() + 1); // Tuesday
  date.setHours(23, 59, 59, 999);
  return date;
}

// Get ISO week number
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

const currentWeek = getWeekNumber(today);
const currentYear = today.getFullYear();

// Default contact person for mock data
const defaultKontaktperson: Kontaktperson = {
  navn: 'Kari Olsen',
  epost: 'kari.olsen@nordfjord-salmon.no',
  telefonnummer: '+4798989898',
};

export const mockSeaLiceReports: SeaLiceReport[] = [
  // Current week - pending (not yet submitted)
  {
    id: 'slr-2026-w03',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'sea-lice',
    status: 'pending',

    // API-aligned fields
    klientReferanse: 'slr-2026-w03-site001',
    organisasjonsnummer: '985399077',
    lokalitetsnummer: 45145,
    kontaktperson: defaultKontaktperson,
    rapporteringsaar: currentYear,
    rapporteringsuke: currentWeek,
    sjotemperatur: 8.2,
    lusetelling: {
      voksneHunnlus: 0.0,
      bevegeligeLus: 0.0,
      fastsittendeLus: 0.0,
    },

    // Legacy fields for UI
    weekNumber: currentWeek,
    year: currentYear,
    reportDate: getWeekStart(0),
    deadline: getDeadline(0),
    createdAt: getWeekStart(0),
    updatedAt: now,
    waterTemperature3m: 8.2,
    siteCounts: {
      adultFemale: 0.0,
      mobile: 0.0,
      attached: 0.0,
      averagePerFish: 0.0,
    },
    cageCounts: [],
    treatments: [],
    cleanerFish: [],
    sensitivityTests: [],
    thresholdExceeded: false,
  },

  // Last week - submitted (good lice count)
  {
    id: 'slr-2026-w02',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'sea-lice',
    status: 'submitted',

    // API-aligned fields
    klientReferanse: 'slr-2026-w02-site001',
    organisasjonsnummer: '985399077',
    lokalitetsnummer: 45145,
    kontaktperson: defaultKontaktperson,
    rapporteringsaar: currentYear,
    rapporteringsuke: currentWeek - 1,
    sjotemperatur: 7.8,
    lusetelling: {
      voksneHunnlus: 0.35,
      bevegeligeLus: 0.45,
      fastsittendeLus: 0.22,
    },

    // Legacy fields for UI
    weekNumber: currentWeek - 1,
    year: currentYear,
    reportDate: getWeekStart(-1),
    deadline: getDeadline(-1),
    createdAt: getWeekStart(-1),
    updatedAt: getDeadline(-1),
    submittedAt: new Date(getDeadline(-1).getTime() - 12 * 60 * 60 * 1000),
    submittedBy: 'Kari Olsen',
    waterTemperature3m: 7.8,
    siteCounts: {
      adultFemale: 0.35,
      mobile: 0.45,
      attached: 0.22,
      averagePerFish: 1.02,
    },
    cageCounts: [
      {
        cageId: 'cage-001',
        cageName: 'Cage 1',
        fishCount: 45000,
        sampleSize: 5,
        counts: { adultFemale: 0.30, mobile: 0.40, attached: 0.20, averagePerFish: 0.90 },
      },
      {
        cageId: 'cage-002',
        cageName: 'Cage 2',
        fishCount: 42000,
        sampleSize: 5,
        counts: { adultFemale: 0.32, mobile: 0.42, attached: 0.18, averagePerFish: 0.92 },
      },
      {
        cageId: 'cage-003',
        cageName: 'Cage 3',
        fishCount: 48000,
        sampleSize: 5,
        counts: { adultFemale: 0.38, mobile: 0.48, attached: 0.25, averagePerFish: 1.11 },
      },
      {
        cageId: 'cage-004',
        cageName: 'Cage 4',
        fishCount: 44000,
        sampleSize: 5,
        counts: { adultFemale: 0.40, mobile: 0.50, attached: 0.25, averagePerFish: 1.15 },
      },
    ],
    treatments: [],
    cleanerFish: [
      {
        id: 'cf-001',
        species: 'lumpfish',
        norwegianName: 'Rognkjeks',
        count: 15000,
        deploymentDate: new Date(currentYear, 0, 5),
      },
      {
        id: 'cf-002',
        species: 'ballan_wrasse',
        norwegianName: 'Berggylt',
        count: 8000,
        deploymentDate: new Date(currentYear, 0, 5),
      },
    ],
    sensitivityTests: [],
    thresholdExceeded: false,
  },

  // 2 weeks ago - approved (elevated lice, treatment applied)
  {
    id: 'slr-2026-w01',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'sea-lice',
    status: 'approved',

    // API-aligned fields
    klientReferanse: 'slr-2026-w01-site001',
    organisasjonsnummer: '985399077',
    lokalitetsnummer: 45145,
    kontaktperson: defaultKontaktperson,
    rapporteringsaar: currentYear,
    rapporteringsuke: currentWeek - 2,
    sjotemperatur: 7.5,
    lusetelling: {
      voksneHunnlus: 0.72,
      bevegeligeLus: 0.85,
      fastsittendeLus: 0.45,
    },
    // Non-medicated treatment - ALIGNED WITH API
    ikkeMedikamentelleBehandlinger: [
      {
        type: 'TERMISK_BEHANDLING',
        gjennomfortForTelling: true,
        heleLokaliteten: true,
        beskrivelse: 'Thermal treatment at 34°C for 30 seconds (Thermolicer)',
      },
    ],

    // Legacy fields for UI
    weekNumber: currentWeek - 2,
    year: currentYear,
    reportDate: getWeekStart(-2),
    deadline: getDeadline(-2),
    createdAt: getWeekStart(-2),
    updatedAt: getDeadline(-2),
    submittedAt: new Date(getDeadline(-2).getTime() - 24 * 60 * 60 * 1000),
    submittedBy: 'Kari Olsen',
    waterTemperature3m: 7.5,
    siteCounts: {
      adultFemale: 0.72,
      mobile: 0.85,
      attached: 0.45,
      averagePerFish: 2.02,
    },
    cageCounts: [
      {
        cageId: 'cage-001',
        cageName: 'Cage 1',
        fishCount: 45000,
        sampleSize: 5,
        counts: { adultFemale: 0.65, mobile: 0.80, attached: 0.40, averagePerFish: 1.85 },
      },
      {
        cageId: 'cage-002',
        cageName: 'Cage 2',
        fishCount: 42000,
        sampleSize: 5,
        counts: { adultFemale: 0.70, mobile: 0.82, attached: 0.42, averagePerFish: 1.94 },
      },
      {
        cageId: 'cage-003',
        cageName: 'Cage 3',
        fishCount: 48000,
        sampleSize: 5,
        counts: { adultFemale: 0.75, mobile: 0.88, attached: 0.48, averagePerFish: 2.11 },
      },
      {
        cageId: 'cage-004',
        cageName: 'Cage 4',
        fishCount: 44000,
        sampleSize: 5,
        counts: { adultFemale: 0.78, mobile: 0.90, attached: 0.50, averagePerFish: 2.18 },
      },
    ],
    treatments: [
      {
        id: 'trt-001',
        type: 'non_medicated',
        date: new Date(currentYear, 0, 10),
        targetCages: ['cage-001', 'cage-002', 'cage-003', 'cage-004'],
        notes: 'Thermal treatment at 34°C for 30 seconds (Thermolicer)',
      },
    ],
    cleanerFish: [
      {
        id: 'cf-003',
        species: 'lumpfish',
        norwegianName: 'Rognkjeks',
        count: 15000,
        deploymentDate: new Date(currentYear, 0, 5),
      },
    ],
    sensitivityTests: [],
    thresholdExceeded: true,
  },

  // Different site - overdue report
  {
    id: 'slr-2026-w02-s2',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'sea-lice',
    status: 'overdue',

    // API-aligned fields
    klientReferanse: 'slr-2026-w02-site002',
    organisasjonsnummer: '987654321',
    lokalitetsnummer: 45200,
    kontaktperson: {
      navn: 'Erik Hansen',
      epost: 'erik.hansen@sognefjord-aqua.no',
      telefonnummer: '+4799887766',
    },
    rapporteringsaar: currentYear,
    rapporteringsuke: currentWeek - 1,
    sjotemperatur: 0,
    lusetelling: {
      voksneHunnlus: 0,
      bevegeligeLus: 0,
      fastsittendeLus: 0,
    },

    // Legacy fields for UI
    weekNumber: currentWeek - 1,
    year: currentYear,
    reportDate: getWeekStart(-1),
    deadline: getDeadline(-1),
    createdAt: getWeekStart(-1),
    updatedAt: getWeekStart(-1),
    waterTemperature3m: 0,
    siteCounts: {
      adultFemale: 0,
      mobile: 0,
      attached: 0,
      averagePerFish: 0,
    },
    cageCounts: [],
    treatments: [],
    cleanerFish: [],
    sensitivityTests: [],
    thresholdExceeded: false,
  },

  // Historical report with sensitivity test and critical lice levels
  {
    id: 'slr-2025-w50',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'sea-lice',
    status: 'approved',

    // API-aligned fields
    klientReferanse: 'slr-2025-w50-site001',
    organisasjonsnummer: '985399077',
    lokalitetsnummer: 45145,
    kontaktperson: defaultKontaktperson,
    rapporteringsaar: currentYear - 1,
    rapporteringsuke: 50,
    sjotemperatur: 6.2,
    lusetelling: {
      voksneHunnlus: 1.15,
      bevegeligeLus: 1.40,
      fastsittendeLus: 0.65,
    },
    // Medicated treatment - ALIGNED WITH API
    medikamentelleBehandlinger: [
      {
        type: 'BADEBEHANDLING',
        gjennomfortForTelling: false,
        heleLokaliteten: true,
        virkestoff: {
          type: 'AZAMETIFOS',
          styrke: {
            verdi: 200,
            enhet: 'MILLIGRAM_PER_LITER',
          },
        },
      },
    ],
    // Sensitivity test - ALIGNED WITH API
    folsomhetsundersokelser: [
      {
        utfortDato: new Date(currentYear - 1, 11, 8).toISOString().split('T')[0],
        laboratorium: 'Norwegian Veterinary Institute',
        resistens: 'AZAMETIFOS',
        testresultat: 'FOLSOM',
      },
    ],

    // Legacy fields for UI
    weekNumber: 50,
    year: currentYear - 1,
    reportDate: new Date(currentYear - 1, 11, 9),
    deadline: new Date(currentYear - 1, 11, 10),
    createdAt: new Date(currentYear - 1, 11, 9),
    updatedAt: new Date(currentYear - 1, 11, 10),
    submittedAt: new Date(currentYear - 1, 11, 10),
    submittedBy: 'Erik Hansen',
    waterTemperature3m: 6.2,
    siteCounts: {
      adultFemale: 1.15,
      mobile: 1.40,
      attached: 0.65,
      averagePerFish: 3.20,
    },
    cageCounts: [
      {
        cageId: 'cage-001',
        cageName: 'Cage 1',
        fishCount: 45000,
        sampleSize: 5,
        counts: { adultFemale: 1.10, mobile: 1.35, attached: 0.60, averagePerFish: 3.05 },
      },
      {
        cageId: 'cage-002',
        cageName: 'Cage 2',
        fishCount: 42000,
        sampleSize: 5,
        counts: { adultFemale: 1.20, mobile: 1.45, attached: 0.70, averagePerFish: 3.35 },
      },
      {
        cageId: 'cage-003',
        cageName: 'Cage 3',
        fishCount: 48000,
        sampleSize: 5,
        counts: { adultFemale: 1.12, mobile: 1.38, attached: 0.62, averagePerFish: 3.12 },
      },
      {
        cageId: 'cage-004',
        cageName: 'Cage 4',
        fishCount: 44000,
        sampleSize: 5,
        counts: { adultFemale: 1.18, mobile: 1.42, attached: 0.68, averagePerFish: 3.28 },
      },
    ],
    treatments: [
      {
        id: 'trt-002',
        type: 'medicated',
        activeIngredient: 'Azamethiphos',
        amount: 200,
        unit: 'mg/L',
        date: new Date(currentYear - 1, 11, 12),
        targetCages: ['cage-001', 'cage-002', 'cage-003', 'cage-004'],
        notes: 'Bath treatment due to elevated lice levels',
      },
    ],
    cleanerFish: [
      {
        id: 'cf-004',
        species: 'lumpfish',
        norwegianName: 'Rognkjeks',
        count: 12000,
        deploymentDate: new Date(currentYear - 1, 9, 15),
      },
    ],
    sensitivityTests: [
      {
        id: 'st-001',
        testDate: new Date(currentYear - 1, 11, 8),
        activeIngredient: 'Azamethiphos',
        result: 'sensitive',
        resistanceSuspected: false,
        labName: 'Norwegian Veterinary Institute',
        notes: 'Full sensitivity confirmed, treatment proceeded',
      },
    ],
    thresholdExceeded: true,
  },
];

/**
 * Get sea lice reports by status
 */
export function getSeaLiceReportsByStatus(status: ReportStatus): SeaLiceReport[] {
  return mockSeaLiceReports.filter((report) => report.status === status);
}

/**
 * Get sea lice reports by site
 */
export function getSeaLiceReportsBySite(siteId: string): SeaLiceReport[] {
  return mockSeaLiceReports.filter((report) => report.siteId === siteId);
}

/**
 * Get reports exceeding threshold
 */
export function getReportsExceedingThreshold(): SeaLiceReport[] {
  return mockSeaLiceReports.filter(
    (report) => report.siteCounts.adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL
  );
}

/**
 * Get current week pending reports
 */
export function getPendingSeaLiceReports(): SeaLiceReport[] {
  return mockSeaLiceReports.filter(
    (report) => report.status === 'pending' || report.status === 'overdue'
  );
}

/**
 * Get the latest report for a site
 */
export function getLatestSeaLiceReport(siteId: string): SeaLiceReport | undefined {
  return mockSeaLiceReports
    .filter((report) => report.siteId === siteId)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.weekNumber - a.weekNumber;
    })[0];
}
