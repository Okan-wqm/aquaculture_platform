/**
 * Slaughter Report Mock Data
 * Event-based kesim reports for planned and completed slaughters
 */

import {
  SlaughterReport,
  PlannedSlaughterReport,
  ExecutedSlaughterReport,
  ReportStatus,
  SlaughterReportType,
} from '../types/reports.types';

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

export const mockSlaughterReports: SlaughterReport[] = [
  // Upcoming planned slaughters - pending
  {
    id: 'sla-2026-001',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter',
    status: 'pending',
    reportPeriodType: 'planned',
    createdAt: now,
    updatedAt: now,
    plannedSlaughters: [
      {
        planId: 'plan-001',
        batchId: 'batch-010',
        batchNumber: 'NF-2024-010',
        speciesName: 'Atlantic Salmon',
        plannedDate: nextWeek,
        estimatedQuantity: 25000,
        estimatedBiomassKg: 112500,
        estimatedAvgWeightKg: 4.5,
        slaughterHouse: 'Marine Harvest Processing',
        status: 'planned',
        notes: 'Premium grade fish, targeting export market',
      },
      {
        planId: 'plan-002',
        batchId: 'batch-011',
        batchNumber: 'NF-2024-011',
        speciesName: 'Atlantic Salmon',
        plannedDate: twoWeeksFromNow,
        estimatedQuantity: 18000,
        estimatedBiomassKg: 72000,
        estimatedAvgWeightKg: 4.0,
        slaughterHouse: 'Marine Harvest Processing',
        status: 'approved',
        approvedAt: yesterday,
        notes: 'Standard harvest for domestic market',
      },
    ],
    completedSlaughters: [],
    summary: {
      totalPlanned: 43000,
      totalCompleted: 0,
      plannedBiomassKg: 184500,
      completedBiomassKg: 0,
    },
  },

  // Completed slaughter report - submitted
  {
    id: 'sla-2026-002',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter',
    status: 'submitted',
    reportPeriodType: 'completed',
    createdAt: weekAgo,
    updatedAt: yesterday,
    submittedAt: yesterday,
    submittedBy: 'Erik Hansen',
    plannedSlaughters: [],
    completedSlaughters: [
      {
        recordId: 'harv-003',
        batchId: 'batch-008',
        batchNumber: 'NF-2024-008',
        speciesName: 'Atlantic Salmon',
        harvestDate: weekAgo,
        actualQuantity: 21500,
        actualBiomassKg: 90300,
        avgWeightKg: 4.2,
        slaughterHouse: 'Marine Harvest Processing',
        qualityGrade: 'Superior',
        lotNumber: 'LOT-2026-NF-001',
        notes: 'Excellent harvest, above average weights',
      },
    ],
    summary: {
      totalPlanned: 22000,
      totalCompleted: 21500,
      plannedBiomassKg: 88000,
      completedBiomassKg: 90300,
    },
  },

  // Historical approved report
  {
    id: 'sla-2025-010',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter',
    status: 'approved',
    reportPeriodType: 'completed',
    createdAt: twoWeeksAgo,
    updatedAt: weekAgo,
    submittedAt: twoWeeksAgo,
    submittedBy: 'Kari Olsen',
    plannedSlaughters: [],
    completedSlaughters: [
      {
        recordId: 'harv-002',
        batchId: 'batch-007',
        batchNumber: 'NF-2024-007',
        speciesName: 'Atlantic Salmon',
        harvestDate: twoWeeksAgo,
        actualQuantity: 17800,
        actualBiomassKg: 69420,
        avgWeightKg: 3.9,
        slaughterHouse: 'Norway Royal Salmon Processing',
        qualityGrade: 'Ordinary',
        lotNumber: 'LOT-2025-NF-052',
        notes: 'Slightly below target weight, early harvest due to disease pressure',
      },
      {
        recordId: 'harv-001',
        batchId: 'batch-006',
        batchNumber: 'NF-2024-006',
        speciesName: 'Atlantic Salmon',
        harvestDate: new Date(twoWeeksAgo.getTime() - 2 * 24 * 60 * 60 * 1000),
        actualQuantity: 14850,
        actualBiomassKg: 61281,
        avgWeightKg: 4.13,
        slaughterHouse: 'Marine Harvest Processing',
        qualityGrade: 'Superior',
        lotNumber: 'LOT-2025-NF-051',
        notes: 'Good harvest quality',
      },
    ],
    summary: {
      totalPlanned: 33000,
      totalCompleted: 32650,
      plannedBiomassKg: 132000,
      completedBiomassKg: 130701,
    },
  },

  // Different site - in progress (partially completed)
  {
    id: 'sla-2026-003',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'slaughter',
    status: 'draft',
    reportPeriodType: 'planned',
    createdAt: weekAgo,
    updatedAt: now,
    plannedSlaughters: [
      {
        planId: 'plan-sf-001',
        batchId: 'batch-sf-005',
        batchNumber: 'SF-2024-005',
        speciesName: 'Atlantic Salmon',
        plannedDate: nextWeek,
        estimatedQuantity: 20000,
        estimatedBiomassKg: 86000,
        estimatedAvgWeightKg: 4.3,
        slaughterHouse: 'Lerøy Processing',
        status: 'planned',
      },
    ],
    completedSlaughters: [
      {
        recordId: 'harv-sf-001',
        batchId: 'batch-sf-004',
        batchNumber: 'SF-2024-004',
        speciesName: 'Atlantic Salmon',
        harvestDate: yesterday,
        actualQuantity: 11800,
        actualBiomassKg: 49560,
        avgWeightKg: 4.2,
        slaughterHouse: 'Lerøy Processing',
        qualityGrade: 'Superior',
        lotNumber: 'LOT-2026-SF-001',
      },
    ],
    summary: {
      totalPlanned: 20000,
      totalCompleted: 11800,
      plannedBiomassKg: 86000,
      completedBiomassKg: 49560,
    },
  },
];

/**
 * Get slaughter reports by status
 */
export function getSlaughterReportsByStatus(status: ReportStatus): SlaughterReport[] {
  return mockSlaughterReports.filter((report) => report.status === status);
}

/**
 * Get slaughter reports by site
 */
export function getSlaughterReportsBySite(siteId: string): SlaughterReport[] {
  return mockSlaughterReports.filter((report) => report.siteId === siteId);
}

/**
 * Get slaughter reports by type
 */
export function getSlaughterReportsByType(
  type: SlaughterReportType
): SlaughterReport[] {
  return mockSlaughterReports.filter((report) => report.reportPeriodType === type);
}

/**
 * Get pending slaughter reports (with upcoming or incomplete harvests)
 */
export function getPendingSlaughterReports(): SlaughterReport[] {
  return mockSlaughterReports.filter(
    (report) =>
      report.status === 'pending' ||
      report.status === 'draft' ||
      (report.plannedSlaughters.length > 0 &&
        report.plannedSlaughters.some((p) => p.status === 'planned' || p.status === 'approved'))
  );
}

/**
 * Get the latest report for a site
 */
export function getLatestSlaughterReport(siteId: string): SlaughterReport | undefined {
  return mockSlaughterReports
    .filter((report) => report.siteId === siteId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/**
 * Calculate harvest variance (planned vs actual)
 */
export function calculateHarvestVariance(report: SlaughterReport): {
  quantityVariance: number;
  biomassVariance: number;
  quantityVariancePercent: number;
  biomassVariancePercent: number;
} {
  const { totalPlanned, totalCompleted, plannedBiomassKg, completedBiomassKg } = report.summary;

  return {
    quantityVariance: totalCompleted - totalPlanned,
    biomassVariance: completedBiomassKg - plannedBiomassKg,
    quantityVariancePercent: totalPlanned > 0
      ? ((totalCompleted - totalPlanned) / totalPlanned) * 100
      : 0,
    biomassVariancePercent: plannedBiomassKg > 0
      ? ((completedBiomassKg - plannedBiomassKg) / plannedBiomassKg) * 100
      : 0,
  };
}

/**
 * Get upcoming slaughters within days
 */
export function getUpcomingSlaughters(days: number = 14): {
  report: SlaughterReport;
  plan: SlaughterReport['plannedSlaughters'][0];
}[] {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  return mockSlaughterReports.flatMap((report) =>
    report.plannedSlaughters
      .filter((plan) => plan.plannedDate <= cutoff && plan.status !== 'completed')
      .map((plan) => ({ report, plan }))
  );
}

// ============================================================================
// Mattilsynet API Slaughter Reports
// ============================================================================

/**
 * Get current week number
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

const currentWeek = getWeekNumber(now);
const currentYear = now.getFullYear();
const previousWeek = currentWeek > 1 ? currentWeek - 1 : 52;
const previousWeekYear = currentWeek > 1 ? currentYear : currentYear - 1;

/**
 * Planned Slaughter Reports (Planlagt Slakt) - Weekly to Mattilsynet API
 * Endpoint: POST /api/slakt/v1/planlagt
 */
export const mockPlannedSlaughterReports: PlannedSlaughterReport[] = [
  // Current week - pending
  {
    id: 'pslakt-2026-w03',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter-planned',
    status: 'pending',
    week: currentWeek,
    year: currentYear,
    deadline: new Date(currentYear, now.getMonth(), now.getDate() + (7 - now.getDay())), // End of week
    createdAt: now,
    updatedAt: now,
    // Mattilsynet API required fields
    klientReferanse: `PSLAKT-${currentYear}-W${currentWeek.toString().padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: '31234',
    kontaktperson: 'Erik Hansen',
    godkjenningsnummer: 'H-001234',
    godkjenningsnavn: 'Marine Harvest Processing AS',
    planlagteLokaliteter: [
      {
        lokalitetsnummer: '31234',
        lokalitetsnavn: 'Nordfjord Salmon Farm',
        art: 'Atlantisk laks',
        artskode: '101',
        antall: 25000,
        mengdeKg: 112500,
        gjennomsnittsvektKg: 4.5,
        slakteDato: nextWeek,
        batchId: 'batch-010',
        batchNumber: 'NF-2024-010',
      },
    ],
    notes: 'Premium grade fish, targeting export market',
  },

  // Previous week - submitted
  {
    id: 'pslakt-2026-w02',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter-planned',
    status: 'submitted',
    week: previousWeek,
    year: previousWeekYear,
    deadline: new Date(previousWeekYear, now.getMonth(), now.getDate() - now.getDay()),
    createdAt: weekAgo,
    updatedAt: yesterday,
    submittedAt: yesterday,
    submittedBy: 'Kari Olsen',
    // Mattilsynet API required fields
    klientReferanse: `PSLAKT-${previousWeekYear}-W${previousWeek.toString().padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: '31234',
    kontaktperson: 'Kari Olsen',
    godkjenningsnummer: 'H-001234',
    godkjenningsnavn: 'Marine Harvest Processing AS',
    planlagteLokaliteter: [
      {
        lokalitetsnummer: '31234',
        lokalitetsnavn: 'Nordfjord Salmon Farm',
        art: 'Atlantisk laks',
        artskode: '101',
        antall: 22000,
        mengdeKg: 88000,
        gjennomsnittsvektKg: 4.0,
        slakteDato: now,
        batchId: 'batch-008',
        batchNumber: 'NF-2024-008',
      },
    ],
  },
];

/**
 * Executed Slaughter Reports (Utført Slakt) - Weekly to Mattilsynet API
 * Endpoint: POST /api/slakt/v1/utfort
 */
export const mockExecutedSlaughterReports: ExecutedSlaughterReport[] = [
  // Current week - draft (in progress)
  {
    id: 'eslakt-2026-w03',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter-executed',
    status: 'draft',
    slakteuke: currentWeek,
    slakteår: currentYear,
    deadline: new Date(currentYear, now.getMonth(), now.getDate() + (7 - now.getDay())),
    createdAt: now,
    updatedAt: now,
    // Mattilsynet API required fields
    klientReferanse: `ESLAKT-${currentYear}-W${currentWeek.toString().padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: '31234',
    kontaktperson: 'Erik Hansen',
    godkjenningsnummer: 'H-001234',
    godkjenningsnavn: 'Marine Harvest Processing AS',
    utførteLokaliteter: [],
  },

  // Previous week - submitted
  {
    id: 'eslakt-2026-w02',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter-executed',
    status: 'submitted',
    slakteuke: previousWeek,
    slakteår: previousWeekYear,
    deadline: new Date(previousWeekYear, now.getMonth(), now.getDate() - now.getDay()),
    createdAt: weekAgo,
    updatedAt: yesterday,
    submittedAt: yesterday,
    submittedBy: 'Kari Olsen',
    // Mattilsynet API required fields
    klientReferanse: `ESLAKT-${previousWeekYear}-W${previousWeek.toString().padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: '31234',
    kontaktperson: 'Kari Olsen',
    godkjenningsnummer: 'H-001234',
    godkjenningsnavn: 'Marine Harvest Processing AS',
    utførteLokaliteter: [
      {
        lokalitetsnummer: '31234',
        lokalitetsnavn: 'Nordfjord Salmon Farm',
        art: 'Atlantisk laks',
        artskode: '101',
        antall: 21500,
        mengdeKg: 90300,
        gjennomsnittsvektKg: 4.2,
        slakteDato: weekAgo,
        kvalitetsgrad: 'Superior',
        batchId: 'batch-008',
        batchNumber: 'NF-2024-008',
        lotNumber: 'LOT-2026-NF-001',
      },
    ],
    notes: 'Excellent harvest, above average weights',
  },

  // 2 weeks ago - approved
  {
    id: 'eslakt-2026-w01',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'slaughter-executed',
    status: 'approved',
    slakteuke: previousWeek > 1 ? previousWeek - 1 : 51,
    slakteår: previousWeek > 1 ? previousWeekYear : previousWeekYear - 1,
    deadline: twoWeeksAgo,
    createdAt: twoWeeksAgo,
    updatedAt: weekAgo,
    submittedAt: twoWeeksAgo,
    submittedBy: 'Erik Hansen',
    // Mattilsynet API required fields
    klientReferanse: `ESLAKT-${previousWeekYear}-W${(previousWeek > 1 ? previousWeek - 1 : 51).toString().padStart(2, '0')}-001`,
    organisasjonsnummer: '987654321',
    lokalitetsnummer: '31234',
    kontaktperson: 'Erik Hansen',
    godkjenningsnummer: 'H-001234',
    godkjenningsnavn: 'Marine Harvest Processing AS',
    utførteLokaliteter: [
      {
        lokalitetsnummer: '31234',
        lokalitetsnavn: 'Nordfjord Salmon Farm',
        art: 'Atlantisk laks',
        artskode: '101',
        antall: 17800,
        mengdeKg: 69420,
        gjennomsnittsvektKg: 3.9,
        slakteDato: twoWeeksAgo,
        kvalitetsgrad: 'Ordinary',
        batchId: 'batch-007',
        batchNumber: 'NF-2024-007',
        lotNumber: 'LOT-2025-NF-052',
      },
      {
        lokalitetsnummer: '31234',
        lokalitetsnavn: 'Nordfjord Salmon Farm',
        art: 'Atlantisk laks',
        artskode: '101',
        antall: 14850,
        mengdeKg: 61281,
        gjennomsnittsvektKg: 4.13,
        slakteDato: new Date(twoWeeksAgo.getTime() - 2 * 24 * 60 * 60 * 1000),
        kvalitetsgrad: 'Superior',
        batchId: 'batch-006',
        batchNumber: 'NF-2024-006',
        lotNumber: 'LOT-2025-NF-051',
      },
    ],
    notes: 'Early harvest due to disease pressure',
  },
];

/**
 * Get planned slaughter reports by status
 */
export function getPlannedSlaughterReportsByStatus(
  status: ReportStatus
): PlannedSlaughterReport[] {
  return mockPlannedSlaughterReports.filter((report) => report.status === status);
}

/**
 * Get executed slaughter reports by status
 */
export function getExecutedSlaughterReportsByStatus(
  status: ReportStatus
): ExecutedSlaughterReport[] {
  return mockExecutedSlaughterReports.filter((report) => report.status === status);
}

/**
 * Get pending Mattilsynet slaughter reports
 */
export function getPendingMattilsynetSlaughterReports(): (
  | PlannedSlaughterReport
  | ExecutedSlaughterReport
)[] {
  const pendingPlanned = mockPlannedSlaughterReports.filter(
    (r) => r.status === 'pending' || r.status === 'draft'
  );
  const pendingExecuted = mockExecutedSlaughterReports.filter(
    (r) => r.status === 'pending' || r.status === 'draft'
  );
  return [...pendingPlanned, ...pendingExecuted];
}
