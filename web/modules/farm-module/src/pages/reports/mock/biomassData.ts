/**
 * Biomass Report Mock Data
 * Monthly biomass reports to Fiskeridirektoratet (due 7th of each month)
 */

import { BiomassReport, ReportStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';

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

export const mockBiomassReports: BiomassReport[] = [
  // Current month - pending (draft started)
  {
    id: 'bio-2026-01',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'biomass',
    status: 'draft',
    month: currentMonth,
    year: currentYear,
    reportDate: new Date(currentYear, currentMonth, 1),
    deadline: getDeadline(currentMonth + 1, currentYear),
    createdAt: new Date(currentYear, currentMonth, 1),
    updatedAt: now,
    currentBiomass: {
      totalKg: 485000,
      bySpecies: [
        {
          speciesId: 'sp-001',
          speciesName: 'Atlantic Salmon',
          biomassKg: 485000,
          fishCount: 125000,
          avgWeightG: 3880,
        },
      ],
    },
    stockings: [],
    mortality: {
      totalCount: 0,
      totalBiomassKg: 0,
      byCause: [],
      details: [],
    },
    slaughter: {
      totalQuantity: 0,
      totalBiomassKg: 0,
      records: [],
    },
    transfers: {
      incoming: [],
      outgoing: [],
    },
    feedConsumption: {
      totalKg: 0,
      byFeedType: [],
    },
  },

  // Previous month - submitted and approved
  {
    id: 'bio-2025-12',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'biomass',
    status: 'approved',
    month: prevMonth,
    year: prevMonthYear,
    reportDate: new Date(prevMonthYear, prevMonth, 1),
    deadline: getDeadline(prevMonth + 1, prevMonthYear),
    createdAt: new Date(prevMonthYear, prevMonth, 1),
    updatedAt: new Date(currentYear, currentMonth, 5),
    submittedAt: new Date(currentYear, currentMonth, 5),
    submittedBy: 'Erik Hansen',
    currentBiomass: {
      totalKg: 478000,
      bySpecies: [
        {
          speciesId: 'sp-001',
          speciesName: 'Atlantic Salmon',
          biomassKg: 478000,
          fishCount: 128000,
          avgWeightG: 3730,
        },
      ],
    },
    stockings: [
      {
        id: 'stock-001',
        date: new Date(prevMonthYear, prevMonth, 5),
        speciesId: 'sp-001',
        speciesName: 'Atlantic Salmon',
        yearClass: prevMonthYear,
        quantity: 15000,
        avgWeightG: 120,
        totalBiomassKg: 1800,
        sourceSupplier: 'Smolt AS Bergen',
        batchNumber: 'SMO-2025-045',
      },
    ],
    mortality: {
      totalCount: 2150,
      totalBiomassKg: 7525,
      byCause: [
        { cause: 'disease', count: 850, biomassKg: 2975 },
        { cause: 'handling', count: 320, biomassKg: 1120 },
        { cause: 'predator', count: 180, biomassKg: 630 },
        { cause: 'unknown', count: 800, biomassKg: 2800 },
      ],
      details: [
        {
          id: 'mort-001',
          date: new Date(prevMonthYear, prevMonth, 8),
          count: 420,
          biomassKg: 1470,
          cause: 'disease',
          notes: 'Elevated mortality following treatment stress',
        },
        {
          id: 'mort-002',
          date: new Date(prevMonthYear, prevMonth, 15),
          count: 650,
          biomassKg: 2275,
          cause: 'disease',
          notes: 'CMS-related mortality in cages 3-4',
        },
        {
          id: 'mort-003',
          date: new Date(prevMonthYear, prevMonth, 22),
          count: 1080,
          biomassKg: 3780,
          cause: 'multiple',
          notes: 'Combined causes including predator and handling',
        },
      ],
    },
    slaughter: {
      totalQuantity: 18500,
      totalBiomassKg: 74000,
      records: [
        {
          id: 'slaugh-001',
          batchId: 'batch-008',
          batchNumber: 'NF-2024-008',
          date: new Date(prevMonthYear, prevMonth, 18),
          quantity: 10000,
          biomassKg: 42000,
          avgWeightKg: 4.2,
          destination: 'Marine Harvest Processing',
          qualityGrade: 'Superior',
        },
        {
          id: 'slaugh-002',
          batchId: 'batch-009',
          batchNumber: 'NF-2024-009',
          date: new Date(prevMonthYear, prevMonth, 25),
          quantity: 8500,
          biomassKg: 32000,
          avgWeightKg: 3.76,
          destination: 'Marine Harvest Processing',
          qualityGrade: 'Ordinary',
        },
      ],
    },
    transfers: {
      incoming: [
        {
          id: 'trans-001',
          date: new Date(prevMonthYear, prevMonth, 5),
          fromSite: 'Smolt AS Bergen',
          quantity: 15000,
          biomassKg: 1800,
          batchNumber: 'SMO-2025-045',
          reason: 'Smolt stocking',
        },
      ],
      outgoing: [],
    },
    feedConsumption: {
      totalKg: 42500,
      byFeedType: [
        {
          feedId: 'feed-001',
          feedName: 'EWOS Harmony 9mm',
          brandName: 'Cargill',
          quantityKg: 28000,
        },
        {
          feedId: 'feed-002',
          feedName: 'EWOS Harmony 7mm',
          brandName: 'Cargill',
          quantityKg: 14500,
        },
      ],
    },
    netImpregnation: [
      {
        cageId: 'cage-001',
        cageName: 'Cage 1',
        impregnationType: 'copper-based',
        activeIngredient: 'Copper pyrithione',
        lastImpregnationDate: new Date(prevMonthYear, prevMonth - 2, 15),
      },
      {
        cageId: 'cage-002',
        cageName: 'Cage 2',
        impregnationType: 'copper-based',
        activeIngredient: 'Copper pyrithione',
        lastImpregnationDate: new Date(prevMonthYear, prevMonth - 2, 15),
      },
    ],
  },

  // 2 months ago - approved
  {
    id: 'bio-2025-11',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'biomass',
    status: 'approved',
    month: twoMonthsAgo,
    year: twoMonthsAgoYear,
    reportDate: new Date(twoMonthsAgoYear, twoMonthsAgo, 1),
    deadline: getDeadline(twoMonthsAgo + 1, twoMonthsAgoYear),
    createdAt: new Date(twoMonthsAgoYear, twoMonthsAgo, 1),
    updatedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 6),
    submittedAt: new Date(twoMonthsAgoYear, twoMonthsAgo + 1, 6),
    submittedBy: 'Kari Olsen',
    currentBiomass: {
      totalKg: 465000,
      bySpecies: [
        {
          speciesId: 'sp-001',
          speciesName: 'Atlantic Salmon',
          biomassKg: 465000,
          fishCount: 132000,
          avgWeightG: 3520,
        },
      ],
    },
    stockings: [],
    mortality: {
      totalCount: 1850,
      totalBiomassKg: 6475,
      byCause: [
        { cause: 'disease', count: 720, biomassKg: 2520 },
        { cause: 'handling', count: 280, biomassKg: 980 },
        { cause: 'environmental', count: 450, biomassKg: 1575 },
        { cause: 'unknown', count: 400, biomassKg: 1400 },
      ],
      details: [],
    },
    slaughter: {
      totalQuantity: 0,
      totalBiomassKg: 0,
      records: [],
    },
    transfers: {
      incoming: [],
      outgoing: [],
    },
    feedConsumption: {
      totalKg: 38500,
      byFeedType: [
        {
          feedId: 'feed-001',
          feedName: 'EWOS Harmony 9mm',
          brandName: 'Cargill',
          quantityKg: 38500,
        },
      ],
    },
  },

  // Different site - overdue
  {
    id: 'bio-2025-12-s2',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'biomass',
    status: 'overdue',
    month: prevMonth,
    year: prevMonthYear,
    reportDate: new Date(prevMonthYear, prevMonth, 1),
    deadline: getDeadline(prevMonth + 1, prevMonthYear),
    createdAt: new Date(prevMonthYear, prevMonth, 1),
    updatedAt: new Date(prevMonthYear, prevMonth, 1),
    currentBiomass: {
      totalKg: 0,
      bySpecies: [],
    },
    stockings: [],
    mortality: {
      totalCount: 0,
      totalBiomassKg: 0,
      byCause: [],
      details: [],
    },
    slaughter: {
      totalQuantity: 0,
      totalBiomassKg: 0,
      records: [],
    },
    transfers: {
      incoming: [],
      outgoing: [],
    },
    feedConsumption: {
      totalKg: 0,
      byFeedType: [],
    },
  },
];

/**
 * Get biomass reports by status
 */
export function getBiomassReportsByStatus(status: ReportStatus): BiomassReport[] {
  return mockBiomassReports.filter((report) => report.status === status);
}

/**
 * Get biomass reports by site
 */
export function getBiomassReportsBySite(siteId: string): BiomassReport[] {
  return mockBiomassReports.filter((report) => report.siteId === siteId);
}

/**
 * Get pending biomass reports
 */
export function getPendingBiomassReports(): BiomassReport[] {
  return mockBiomassReports.filter(
    (report) => report.status === 'pending' || report.status === 'draft' || report.status === 'overdue'
  );
}

/**
 * Get the latest report for a site
 */
export function getLatestBiomassReport(siteId: string): BiomassReport | undefined {
  return mockBiomassReports
    .filter((report) => report.siteId === siteId)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    })[0];
}

/**
 * Calculate total biomass change for a period
 */
export function calculateBiomassChange(report: BiomassReport): {
  stockingKg: number;
  mortalityKg: number;
  slaughterKg: number;
  transferNetKg: number;
  feedKg: number;
} {
  const stockingKg = report.stockings.reduce((sum, s) => sum + s.totalBiomassKg, 0);
  const transferInKg = report.transfers.incoming.reduce((sum, t) => sum + t.biomassKg, 0);
  const transferOutKg = report.transfers.outgoing.reduce((sum, t) => sum + t.biomassKg, 0);

  return {
    stockingKg,
    mortalityKg: report.mortality.totalBiomassKg,
    slaughterKg: report.slaughter.totalBiomassKg,
    transferNetKg: transferInKg - transferOutKg,
    feedKg: report.feedConsumption.totalKg,
  };
}
