/**
 * Cleaner Fish Report Mock Data
 * Monthly rensefisk reports (due 7th of each month)
 *
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 * Endpoint: POST /api/rensefisk/v1/rensefisk
 */

import {
  CleanerFishReport,
  ReportStatus,
  CleanerFishSpecies,
  CleanerFishArtskode,
  CleanerFishOpprinnelse,
  ProduksjonsenhetRensefisk,
  RensefiskArt,
  RensefiskUtsett,
  RensefiskUttak,
  Kontaktperson,
} from '../types/reports.types';

// Default contact person for mock data
const defaultKontaktperson: Kontaktperson = {
  navn: 'Kari Olsen',
  epost: 'kari.olsen@nordfjord-salmon.no',
  telefonnummer: '+4798989898',
};

// Helper to create empty uttak (removal) data
const createEmptyUttak = (): RensefiskUttak => ({
  antallAvlivetSykdom: 0,
  antallAvlivetSkader: 0,
  antallAvlivetAvmagret: 0,
  antallAvlivetForestaendeHaandteringAvLaksen: 0,
  antallAvlivetForestaendeUgunstigLevemiljo: 0,
  antallAvlivetSkalIkkeBrukes: 0,
  antallSelvdod: 0,
  antallFlyttetUt: 0,
  antallKanIkkeGjoresRedeFor: 0,
});

// Helper to create empty utsett (deployment) data
const createEmptyUtsett = (): RensefiskUtsett => ({
  antallFlyttetInn: 0,
  antallNy: 0,
});

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

export const mockCleanerFishReports: CleanerFishReport[] = [
  // Current month - draft
  {
    id: 'clf-2026-01',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'cleaner-fish',
    status: 'draft',

    // API-aligned fields
    rapporteringsmaaned: currentMonth + 1,  // 1-indexed for API
    rapporteringsaar: currentYear,
    klientReferanse: `CLF-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: 31234,  // NUMBER not string
    kontaktperson: defaultKontaktperson,

    // Production cycle and feed data
    produksjonssyklusStart: new Date(2025, 2, 15).toISOString(),
    torrforKg: 0,
    vatforKg: 0,

    // Production units - empty for draft
    produksjonsenheter: [],

    // Legacy fields for UI
    month: currentMonth,
    year: currentYear,
    deadline: getDeadline(currentMonth + 1, currentYear),
    createdAt: new Date(currentYear, currentMonth, 1),
    updatedAt: now,
    fishBySpecies: [],
    totalCount: 0,
    mortality: {
      bySpecies: [],
      totalCount: 0,
      overallRate: 0,
    },
    deployments: [],
  },

  // Previous month - submitted and approved
  {
    id: 'clf-2025-12',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'cleaner-fish',
    status: 'approved',

    // API-aligned fields
    rapporteringsmaaned: prevMonth + 1,  // 1-indexed for API
    rapporteringsaar: prevMonthYear,
    klientReferanse: 'CLF-2025-12-001',
    organisasjonsnummer: '987654321',
    lokalitetsnummer: 31234,  // NUMBER not string
    kontaktperson: defaultKontaktperson,

    // Production cycle and feed data
    produksjonssyklusStart: new Date(2025, 2, 15).toISOString(),
    torrforKg: 1250,   // Dry feed consumption (ASCII-compatible)
    vatforKg: 320,     // Wet feed consumption (ASCII-compatible)

    // Production units with species - ALIGNED WITH API
    produksjonsenheter: [
      {
        merdId: 'cage-001',
        arter: [
          {
            artskode: 'USB' as CleanerFishArtskode,  // Lumpfish (Rognkjeks)
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 4500,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 5000,
            },
            uttak: {
              antallAvlivetSykdom: 120,
              antallAvlivetSkader: 80,
              antallAvlivetAvmagret: 25,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 350,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 45,
            },
          },
          {
            artskode: 'GRO' as CleanerFishArtskode,  // Corkwing Wrasse (Grønngylt)
            opprinnelse: 'VILLFANGET' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 0,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 3500,
            },
            uttak: {
              antallAvlivetSykdom: 50,
              antallAvlivetSkader: 30,
              antallAvlivetAvmagret: 15,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 100,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 15,
            },
          },
        ],
      },
      {
        merdId: 'cage-002',
        arter: [
          {
            artskode: 'USB' as CleanerFishArtskode,  // Lumpfish
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 4200,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 5000,
            },
            uttak: {
              antallAvlivetSykdom: 100,
              antallAvlivetSkader: 90,
              antallAvlivetAvmagret: 30,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 280,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 50,
            },
          },
        ],
      },
      {
        merdId: 'cage-003',
        arter: [
          {
            artskode: 'BER' as CleanerFishArtskode,  // Ballan Wrasse (Berggylt)
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 3800,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 4000,
            },
            uttak: {
              antallAvlivetSykdom: 80,
              antallAvlivetSkader: 60,
              antallAvlivetAvmagret: 20,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 200,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 40,
            },
          },
        ],
      },
      {
        merdId: 'cage-004',
        arter: [
          {
            artskode: 'BER' as CleanerFishArtskode,  // Ballan Wrasse
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 3600,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 4000,
            },
            uttak: {
              antallAvlivetSykdom: 60,
              antallAvlivetSkader: 50,
              antallAvlivetAvmagret: 10,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 80,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 20,
            },
          },
        ],
      },
    ],

    // Legacy fields for UI
    month: prevMonth,
    year: prevMonthYear,
    deadline: getDeadline(prevMonth + 1, prevMonthYear),
    createdAt: new Date(prevMonthYear, prevMonth, 1),
    updatedAt: new Date(currentYear, currentMonth, 5),
    submittedAt: new Date(currentYear, currentMonth, 5),
    submittedBy: 'Kari Olsen',
    fishBySpecies: [
      {
        species: 'lumpfish' as CleanerFishSpecies,
        norwegianName: 'Rognkjeks',
        count: 15000,
        source: 'farmed',
        sourceLocation: 'Lumpfish AS, Trondheim',
      },
      {
        species: 'ballan_wrasse' as CleanerFishSpecies,
        norwegianName: 'Berggylt',
        count: 8000,
        source: 'farmed',
        sourceLocation: 'Wrasse Farm West',
      },
      {
        species: 'corkwing_wrasse' as CleanerFishSpecies,
        norwegianName: 'Grønngylt',
        count: 3500,
        source: 'wild_caught',
        sourceLocation: 'Local waters, Nordfjord',
      },
    ],
    totalCount: 26500,
    mortality: {
      bySpecies: [
        { species: 'lumpfish' as CleanerFishSpecies, count: 1250, rate: 8.3 },
        { species: 'ballan_wrasse' as CleanerFishSpecies, count: 480, rate: 6.0 },
        { species: 'corkwing_wrasse' as CleanerFishSpecies, count: 210, rate: 6.0 },
      ],
      totalCount: 1940,
      overallRate: 7.3,
    },
    deployments: [
      {
        id: 'dep-001',
        date: new Date(prevMonthYear, prevMonth, 5),
        species: 'lumpfish' as CleanerFishSpecies,
        quantity: 5000,
        targetCageId: 'cage-001',
        targetCageName: 'Cage 1',
        salmonBatchId: 'batch-001',
      },
      {
        id: 'dep-002',
        date: new Date(prevMonthYear, prevMonth, 5),
        species: 'lumpfish' as CleanerFishSpecies,
        quantity: 5000,
        targetCageId: 'cage-002',
        targetCageName: 'Cage 2',
        salmonBatchId: 'batch-002',
      },
      {
        id: 'dep-003',
        date: new Date(prevMonthYear, prevMonth, 12),
        species: 'ballan_wrasse' as CleanerFishSpecies,
        quantity: 4000,
        targetCageId: 'cage-003',
        targetCageName: 'Cage 3',
        salmonBatchId: 'batch-003',
      },
      {
        id: 'dep-004',
        date: new Date(prevMonthYear, prevMonth, 12),
        species: 'ballan_wrasse' as CleanerFishSpecies,
        quantity: 4000,
        targetCageId: 'cage-004',
        targetCageName: 'Cage 4',
        salmonBatchId: 'batch-004',
      },
      {
        id: 'dep-005',
        date: new Date(prevMonthYear, prevMonth, 20),
        species: 'corkwing_wrasse' as CleanerFishSpecies,
        quantity: 3500,
        targetCageId: 'cage-001',
        targetCageName: 'Cage 1',
        salmonBatchId: 'batch-001',
      },
    ],
  },

  // 2 months ago - approved
  {
    id: 'clf-2025-11',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'cleaner-fish',
    status: 'approved',

    // API-aligned fields
    rapporteringsmaaned: twoMonthsAgo + 1,  // 1-indexed for API
    rapporteringsaar: twoMonthsAgoYear,
    klientReferanse: 'CLF-2025-11-001',
    organisasjonsnummer: '987654321',
    lokalitetsnummer: 31234,  // NUMBER not string
    kontaktperson: {
      navn: 'Erik Hansen',
      epost: 'erik.hansen@nordfjord-salmon.no',
      telefonnummer: '+4791234567',
    },

    // Production cycle and feed data
    produksjonssyklusStart: new Date(2025, 2, 15).toISOString(),
    torrforKg: 980,
    vatforKg: 250,

    // Production units with species - ALIGNED WITH API
    produksjonsenheter: [
      {
        merdId: 'cage-001',
        arter: [
          {
            artskode: 'USB' as CleanerFishArtskode,  // Lumpfish
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 4000,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 6000,
            },
            uttak: {
              antallAvlivetSykdom: 150,
              antallAvlivetSkader: 100,
              antallAvlivetAvmagret: 40,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 300,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 60,
            },
          },
        ],
      },
      {
        merdId: 'cage-002',
        arter: [
          {
            artskode: 'USB' as CleanerFishArtskode,  // Lumpfish
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 3800,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 6000,
            },
            uttak: {
              antallAvlivetSykdom: 130,
              antallAvlivetSkader: 80,
              antallAvlivetAvmagret: 30,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 250,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 40,
            },
          },
        ],
      },
      {
        merdId: 'cage-003',
        arter: [
          {
            artskode: 'BER' as CleanerFishArtskode,  // Ballan Wrasse
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 3500,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 3500,
            },
            uttak: {
              antallAvlivetSykdom: 70,
              antallAvlivetSkader: 50,
              antallAvlivetAvmagret: 15,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 150,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 30,
            },
          },
        ],
      },
      {
        merdId: 'cage-004',
        arter: [
          {
            artskode: 'BER' as CleanerFishArtskode,  // Ballan Wrasse
            opprinnelse: 'OPPDRETT' as CleanerFishOpprinnelse,
            beholdningVedForrigeMaanedsslutt: 3200,
            utsett: {
              antallFlyttetInn: 0,
              antallNy: 3000,
            },
            uttak: {
              antallAvlivetSykdom: 50,
              antallAvlivetSkader: 40,
              antallAvlivetAvmagret: 10,
              antallAvlivetForestaendeHaandteringAvLaksen: 0,
              antallAvlivetForestaendeUgunstigLevemiljo: 0,
              antallAvlivetSkalIkkeBrukes: 0,
              antallSelvdod: 100,
              antallFlyttetUt: 0,
              antallKanIkkeGjoresRedeFor: 15,
            },
          },
        ],
      },
    ],

    // Legacy fields for UI
    month: twoMonthsAgo,
    year: twoMonthsAgoYear,
    deadline: getDeadline(twoMonthsAgo + 1, twoMonthsAgoYear),
    createdAt: new Date(twoMonthsAgoYear, twoMonthsAgo, 1),
    updatedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 6),
    submittedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 6),
    submittedBy: 'Erik Hansen',
    fishBySpecies: [
      {
        species: 'lumpfish' as CleanerFishSpecies,
        norwegianName: 'Rognkjeks',
        count: 12000,
        source: 'farmed',
        sourceLocation: 'Lumpfish AS, Trondheim',
      },
      {
        species: 'ballan_wrasse' as CleanerFishSpecies,
        norwegianName: 'Berggylt',
        count: 6500,
        source: 'farmed',
        sourceLocation: 'Wrasse Farm West',
      },
    ],
    totalCount: 18500,
    mortality: {
      bySpecies: [
        { species: 'lumpfish' as CleanerFishSpecies, count: 980, rate: 8.2 },
        { species: 'ballan_wrasse' as CleanerFishSpecies, count: 350, rate: 5.4 },
      ],
      totalCount: 1330,
      overallRate: 7.2,
    },
    deployments: [
      {
        id: 'dep-006',
        date: new Date(twoMonthsAgoYear, twoMonthsAgo, 8),
        species: 'lumpfish' as CleanerFishSpecies,
        quantity: 6000,
        targetCageId: 'cage-001',
        targetCageName: 'Cage 1',
        salmonBatchId: 'batch-001',
      },
      {
        id: 'dep-007',
        date: new Date(twoMonthsAgoYear, twoMonthsAgo, 8),
        species: 'lumpfish' as CleanerFishSpecies,
        quantity: 6000,
        targetCageId: 'cage-002',
        targetCageName: 'Cage 2',
        salmonBatchId: 'batch-002',
      },
    ],
  },

  // Different site - pending
  {
    id: 'clf-2026-01-s2',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'cleaner-fish',
    status: 'pending',

    // API-aligned fields
    rapporteringsmaaned: currentMonth + 1,
    rapporteringsaar: currentYear,
    klientReferanse: `CLF-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-002`,
    organisasjonsnummer: '123456789',
    lokalitetsnummer: 45678,  // NUMBER not string
    kontaktperson: {
      navn: 'Ola Nordmann',
      epost: 'ola.nordmann@sognefjord-aqua.no',
      telefonnummer: '+4799887766',
    },

    // Production cycle and feed data
    produksjonssyklusStart: new Date(2025, 5, 1).toISOString(),
    torrforKg: 0,
    vatforKg: 0,

    // Production units - empty for pending
    produksjonsenheter: [],

    // Legacy fields for UI
    month: currentMonth,
    year: currentYear,
    deadline: getDeadline(currentMonth + 1, currentYear),
    createdAt: new Date(currentYear, currentMonth, 1),
    updatedAt: now,
    fishBySpecies: [],
    totalCount: 0,
    mortality: {
      bySpecies: [],
      totalCount: 0,
      overallRate: 0,
    },
    deployments: [],
  },
];

/**
 * Get cleaner fish reports by status
 */
export function getCleanerFishReportsByStatus(status: ReportStatus): CleanerFishReport[] {
  return mockCleanerFishReports.filter((report) => report.status === status);
}

/**
 * Get cleaner fish reports by site
 */
export function getCleanerFishReportsBySite(siteId: string): CleanerFishReport[] {
  return mockCleanerFishReports.filter((report) => report.siteId === siteId);
}

/**
 * Get pending cleaner fish reports
 */
export function getPendingCleanerFishReports(): CleanerFishReport[] {
  return mockCleanerFishReports.filter(
    (report) => report.status === 'pending' || report.status === 'draft' || report.status === 'overdue'
  );
}

/**
 * Get the latest report for a site
 */
export function getLatestCleanerFishReport(siteId: string): CleanerFishReport | undefined {
  return mockCleanerFishReports
    .filter((report) => report.siteId === siteId)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    })[0];
}

/**
 * Calculate total cleaner fish count by species
 */
export function getTotalCleanerFishBySpecies(
  report: CleanerFishReport
): Record<string, number> {
  return report.fishBySpecies.reduce(
    (acc, fish) => {
      acc[fish.species] = fish.count;
      return acc;
    },
    {} as Record<string, number>
  );
}

/**
 * Calculate cleaner fish to salmon ratio
 */
export function calculateCleanerFishRatio(
  cleanerFishCount: number,
  salmonCount: number
): number {
  if (salmonCount === 0) return 0;
  return (cleanerFishCount / salmonCount) * 100;
}
