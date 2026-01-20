/**
 * Escape Report Mock Data
 */

import { EscapeReport, EscapeStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

export const mockEscapeReports: EscapeReport[] = [
  // Active detected escape - equipment failure
  {
    id: 'esc-001',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'escape',
    status: 'pending',
    escapeStatus: 'detected',
    detectedAt: yesterday,
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: yesterday,
    updatedAt: yesterday,
    escape: {
      estimatedCount: 2500,
      species: 'Atlantic Salmon',
      speciesId: 'SALMON',
      avgWeightG: 3500,
      totalBiomassKg: 8750,
      cause: 'equipment_failure',
      causeDescription: 'Net panel damage discovered during routine inspection. Suspected wear at attachment point.',
    },
    affectedUnits: [
      {
        unitId: 'cage-003',
        unitName: 'Cage 3',
        unitType: 'cage',
        batchId: 'batch-001',
        batchNumber: 'NF-2025-001',
        originalCount: 45000,
        escapedCount: 2500,
      },
    ],
    recovery: {
      recapturedCount: 350,
      recaptureMethod: 'Seine netting around site perimeter',
      ongoingEfforts: true,
      estimatedRemaining: 2150,
    },
    environmentalImpact: {
      nearbyWildPopulations: true,
      riverSystems: ['Nordfjord River', 'Eid River'],
      assessmentRequired: true,
    },
    preventiveMeasures: [
      'Emergency net repair completed',
      'Additional anchor points installed',
      'Increased inspection frequency',
      'Neighboring farms notified',
    ],
  },

  // Reported and under investigation - storm damage
  {
    id: 'esc-002',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'escape',
    status: 'submitted',
    escapeStatus: 'investigation',
    detectedAt: twoDaysAgo,
    reportedAt: twoDaysAgo,
    reportedBy: 'Hans Eriksen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: twoDaysAgo,
    updatedAt: yesterday,
    submittedAt: twoDaysAgo,
    submittedBy: 'Hans Eriksen',
    escape: {
      estimatedCount: 8000,
      species: 'Atlantic Salmon',
      speciesId: 'SALMON',
      avgWeightG: 4200,
      totalBiomassKg: 33600,
      cause: 'storm_damage',
      causeDescription: 'Severe storm (wind gusts >25 m/s) caused mooring line failure and subsequent net damage on cages 5 and 6.',
    },
    affectedUnits: [
      {
        unitId: 'cage-005',
        unitName: 'Cage 5',
        unitType: 'cage',
        batchId: 'batch-004',
        batchNumber: 'SF-2025-003',
        originalCount: 52000,
        escapedCount: 5500,
      },
      {
        unitId: 'cage-006',
        unitName: 'Cage 6',
        unitType: 'cage',
        batchId: 'batch-005',
        batchNumber: 'SF-2025-004',
        originalCount: 48000,
        escapedCount: 2500,
      },
    ],
    recovery: {
      recapturedCount: 1200,
      recaptureMethod: 'Combined seine and gill net operations',
      ongoingEfforts: true,
      estimatedRemaining: 6800,
    },
    environmentalImpact: {
      nearbyWildPopulations: true,
      riverSystems: ['Sognefjord tributaries', 'Laerdal River'],
      assessmentRequired: true,
    },
    preventiveMeasures: [
      'Mooring system completely replaced',
      'Upgraded to storm-rated anchoring',
      'Additional flotation added',
      'Weather monitoring enhanced',
      'Emergency response plan updated',
    ],
    acknowledgement: {
      acknowledgedAt: yesterday,
      acknowledgedBy: 'Fiskeridirektoratet Region West',
      referenceNumber: 'FD-2026-ESC-0042',
      notes: 'Investigation initiated. Environmental assessment team dispatched.',
    },
  },

  // Closed escape incident - predator attack
  {
    id: 'esc-003',
    siteId: 'site-003',
    siteName: 'Hardanger Fish AS',
    reportType: 'escape',
    status: 'approved',
    escapeStatus: 'closed',
    detectedAt: twoWeeksAgo,
    reportedAt: twoWeeksAgo,
    reportedBy: 'Liv Johansen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: twoWeeksAgo,
    updatedAt: weekAgo,
    submittedAt: twoWeeksAgo,
    submittedBy: 'Liv Johansen',
    escape: {
      estimatedCount: 450,
      species: 'Atlantic Salmon',
      speciesId: 'SALMON',
      avgWeightG: 2800,
      totalBiomassKg: 1260,
      cause: 'predator_attack',
      causeDescription: 'Seal attack on net panel caused 3m tear. Discovered during feeding operation.',
    },
    affectedUnits: [
      {
        unitId: 'cage-002',
        unitName: 'Cage B',
        unitType: 'cage',
        batchId: 'batch-006',
        batchNumber: 'HF-2025-002',
        originalCount: 38000,
        escapedCount: 450,
      },
    ],
    recovery: {
      recapturedCount: 280,
      recaptureMethod: 'Seine netting within 24 hours of detection',
      ongoingEfforts: false,
      estimatedRemaining: 170,
    },
    environmentalImpact: {
      nearbyWildPopulations: false,
      riverSystems: [],
      assessmentRequired: false,
    },
    preventiveMeasures: [
      'Predator net installed around affected cage',
      'Acoustic deterrent devices deployed',
      'Net repair completed with reinforced panels',
      'Increased patrol frequency',
    ],
    acknowledgement: {
      acknowledgedAt: twoWeeksAgo,
      acknowledgedBy: 'Fiskeridirektoratet Region West',
      referenceNumber: 'FD-2026-ESC-0038',
    },
    closedAt: weekAgo,
    closureNotes: 'Recovery operations completed. Final count: 280 recaptured, 170 unaccounted. Environmental impact assessment concluded - minimal impact due to small escape volume and quick response. Case closed.',
  },
];

/**
 * Get escape reports by status
 */
export function getEscapeReportsByStatus(status: EscapeStatus): EscapeReport[] {
  return mockEscapeReports.filter((report) => report.escapeStatus === status);
}

/**
 * Get escape reports by cause
 */
export function getEscapeReportsByCause(
  cause: 'equipment_failure' | 'storm_damage' | 'predator_attack' | 'human_error' | 'unknown'
): EscapeReport[] {
  return mockEscapeReports.filter((report) => report.escape.cause === cause);
}

/**
 * Get active (unresolved) escape reports
 */
export function getActiveEscapeReports(): EscapeReport[] {
  return mockEscapeReports.filter(
    (report) => report.escapeStatus !== 'closed'
  );
}

/**
 * Get total escaped fish count from active incidents
 */
export function getTotalEscapedCount(): number {
  return getActiveEscapeReports().reduce(
    (total, report) => total + report.escape.estimatedCount,
    0
  );
}
