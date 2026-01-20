/**
 * Welfare Event Mock Data
 */

import { WelfareEventReport, ReportStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

export const mockWelfareEvents: WelfareEventReport[] = [
  // Active critical event - Mortality threshold exceeded
  {
    id: 'wf-001',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'welfare',
    status: 'pending',
    eventType: 'mortality_threshold',
    severity: 'critical',
    detectedAt: yesterday,
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: yesterday,
    updatedAt: yesterday,
    mortalityData: {
      period: '3_day',
      threshold: 1.0,
      actualRate: 2.3,
      affectedBatches: [
        {
          batchId: 'batch-001',
          batchNumber: 'NF-2025-001',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 1250,
          mortalityRate: 2.3,
        },
        {
          batchId: 'batch-002',
          batchNumber: 'NF-2025-002',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 420,
          mortalityRate: 1.8,
        },
      ],
    },
    immediateActions: [
      'Increased water quality monitoring frequency',
      'Veterinarian consultation scheduled',
      'Fish samples sent to lab',
    ],
  },

  // Reported and acknowledged - Equipment failure
  {
    id: 'wf-002',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'welfare',
    status: 'submitted',
    eventType: 'equipment_failure',
    severity: 'high',
    detectedAt: twoDaysAgo,
    reportedAt: twoDaysAgo,
    reportedBy: 'Ole Hansen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: twoDaysAgo,
    updatedAt: yesterday,
    submittedAt: twoDaysAgo,
    submittedBy: 'Ole Hansen',
    equipmentData: {
      equipmentId: 'pump-003',
      equipmentName: 'Main Circulation Pump #3',
      equipmentType: 'Circulation Pump',
      failureType: 'Mechanical failure',
      injuredFishCount: 150,
      mortalityCount: 45,
      description: 'Main circulation pump failed causing temporary oxygen drop in tanks 5-8. Backup system activated within 15 minutes.',
    },
    immediateActions: [
      'Backup pump system activated',
      'Emergency aeration deployed',
      'Fish transferred from affected tanks',
      'Equipment repair initiated',
    ],
    acknowledgement: {
      acknowledgedAt: yesterday,
      acknowledgedBy: 'Mattilsynet Regional Office',
      referenceNumber: 'MT-2026-00123',
      notes: 'Case registered. Follow-up inspection scheduled.',
    },
  },

  // Resolved event
  {
    id: 'wf-003',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'welfare',
    status: 'approved',
    eventType: 'welfare_impact',
    severity: 'high',
    detectedAt: weekAgo,
    reportedAt: weekAgo,
    reportedBy: 'Kari Olsen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: weekAgo,
    updatedAt: twoDaysAgo,
    submittedAt: weekAgo,
    submittedBy: 'Kari Olsen',
    welfareData: {
      description: 'Unusually high water temperature (23°C) due to weather conditions caused stress symptoms in fish population.',
      affectedFishEstimate: 25000,
      affectedPercentage: 35,
      immediateActions: [
        'Reduced feeding by 50%',
        'Increased water circulation',
        'Deployed shade nets',
        'Continuous temperature monitoring',
      ],
      ongoingRisks: ['Continued heat wave expected for 3 more days'],
    },
    immediateActions: [
      'Reduced feeding by 50%',
      'Increased water circulation',
      'Deployed shade nets',
      'Continuous temperature monitoring',
    ],
    acknowledgement: {
      acknowledgedAt: weekAgo,
      acknowledgedBy: 'Mattilsynet Regional Office',
      referenceNumber: 'MT-2026-00089',
    },
    resolvedAt: twoDaysAgo,
    resolutionNotes: 'Temperature returned to normal levels. Fish recovered, no significant long-term impact observed.',
  },
];

/**
 * Get welfare events by report status
 */
export function getWelfareEventsByStatus(status: ReportStatus): WelfareEventReport[] {
  return mockWelfareEvents.filter((event) => event.status === status);
}

/**
 * Get welfare events by site
 */
export function getWelfareEventsBySite(siteId: string): WelfareEventReport[] {
  return mockWelfareEvents.filter((event) => event.siteId === siteId);
}

/**
 * Get active (unresolved) welfare events
 */
export function getActiveWelfareEvents(): WelfareEventReport[] {
  return mockWelfareEvents.filter(
    (event) => event.status !== 'approved' && !event.resolvedAt
  );
}
