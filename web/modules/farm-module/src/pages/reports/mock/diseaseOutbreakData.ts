/**
 * Disease Outbreak Mock Data
 */

import { DiseaseOutbreakReport, DiseaseStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

export const mockDiseaseOutbreaks: DiseaseOutbreakReport[] = [
  // Active suspected outbreak - PD
  {
    id: 'dis-001',
    siteId: 'site-001',
    siteName: 'Nordfjord Salmon Farm',
    reportType: 'disease',
    status: 'pending',
    diseaseStatus: 'detected',
    detectedAt: yesterday,
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: yesterday,
    updatedAt: yesterday,
    disease: {
      category: 'C',
      name: 'Pancreas Disease',
      norwegianName: 'Pankreassykdom',
      code: 'PD',
      suspectedOrConfirmed: 'suspected',
    },
    affectedPopulation: {
      estimatedCount: 3500,
      percentage: 7,
      batches: [
        {
          batchId: 'batch-001',
          batchNumber: 'NF-2025-001',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 120,
        },
      ],
      tanks: ['Cage-01', 'Cage-02'],
    },
    facility: {
      siteId: 'site-001',
      siteName: 'Nordfjord Salmon Farm',
      siteCode: 'NF-001',
      gpsCoordinates: {
        lat: 61.9052,
        lng: 5.9851,
      },
    },
    clinicalSigns: [
      'Reduced appetite',
      'Abnormal swimming behavior',
      'Darkening of skin',
      'Hemorrhages around eyes',
    ],
    labResults: [],
    immediateActions: [
      'Isolated affected cages',
      'Samples sent to veterinary laboratory',
      'Increased mortality monitoring',
      'Reduced feeding',
    ],
    quarantineMeasures: [
      'Movement restrictions between cages',
      'Enhanced biosecurity protocols',
      'Staff limited to affected area',
    ],
    veterinarianNotified: true,
    veterinarianName: 'Dr. Erik Bergström',
    veterinarianContact: '+47 912 34 567',
  },

  // Under investigation with lab results
  {
    id: 'dis-002',
    siteId: 'site-002',
    siteName: 'Sognefjord Aqua',
    reportType: 'disease',
    status: 'submitted',
    diseaseStatus: 'under_investigation',
    detectedAt: threeDaysAgo,
    reportedAt: threeDaysAgo,
    reportedBy: 'Anna Larsen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: threeDaysAgo,
    updatedAt: yesterday,
    submittedAt: threeDaysAgo,
    submittedBy: 'Anna Larsen',
    disease: {
      category: 'F',
      name: 'Cardiomyopathy Syndrome',
      norwegianName: 'Kardiomyopatisyndrom',
      code: 'CMS',
      suspectedOrConfirmed: 'suspected',
    },
    affectedPopulation: {
      estimatedCount: 1200,
      percentage: 3,
      batches: [
        {
          batchId: 'batch-003',
          batchNumber: 'SF-2025-002',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 85,
        },
      ],
      tanks: ['Tank-A1', 'Tank-A2'],
    },
    facility: {
      siteId: 'site-002',
      siteName: 'Sognefjord Aqua',
      siteCode: 'SF-002',
      gpsCoordinates: {
        lat: 61.2283,
        lng: 7.1055,
      },
    },
    clinicalSigns: [
      'Sudden mortality',
      'Distended abdomen',
      'Pale gills',
      'Lethargy',
    ],
    labResults: [
      {
        id: 'lab-001',
        labName: 'Norwegian Veterinary Institute',
        sampleDate: threeDaysAgo,
        resultDate: yesterday,
        testType: 'Histopathology',
        result: 'Cardiac lesions consistent with CMS',
        interpretation: 'Preliminary positive for CMS, awaiting PCR confirmation',
      },
    ],
    immediateActions: [
      'Reduced stocking density',
      'Optimized water quality parameters',
      'Veterinary consultation',
    ],
    veterinarianNotified: true,
    veterinarianName: 'Dr. Maria Svensson',
    acknowledgement: {
      acknowledgedAt: threeDaysAgo,
      acknowledgedBy: 'Mattilsynet Western Region',
      referenceNumber: 'MT-2026-00156',
    },
  },

  // Confirmed and resolved outbreak
  {
    id: 'dis-003',
    siteId: 'site-003',
    siteName: 'Hardanger Fish AS',
    reportType: 'disease',
    status: 'approved',
    diseaseStatus: 'resolved',
    detectedAt: twoWeeksAgo,
    reportedAt: twoWeeksAgo,
    reportedBy: 'Per Nilsen',
    contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
    createdAt: twoWeeksAgo,
    updatedAt: threeDaysAgo,
    submittedAt: twoWeeksAgo,
    submittedBy: 'Per Nilsen',
    disease: {
      category: 'C',
      name: 'Bacterial Kidney Disease',
      norwegianName: 'Bakteriell nyresyke',
      code: 'BKD',
      suspectedOrConfirmed: 'lab_confirmed',
    },
    affectedPopulation: {
      estimatedCount: 5000,
      percentage: 10,
      batches: [
        {
          batchId: 'batch-005',
          batchNumber: 'HF-2025-003',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 340,
        },
        {
          batchId: 'batch-006',
          batchNumber: 'HF-2025-004',
          speciesName: 'Atlantic Salmon',
          mortalityCount: 180,
        },
      ],
      tanks: ['Cage-A', 'Cage-B', 'Cage-C'],
    },
    facility: {
      siteId: 'site-003',
      siteName: 'Hardanger Fish AS',
      siteCode: 'HF-003',
      gpsCoordinates: {
        lat: 60.0731,
        lng: 6.5475,
      },
    },
    clinicalSigns: [
      'Kidney swelling',
      'Pale liver',
      'Hemorrhages in muscle',
      'Reduced growth',
    ],
    labResults: [
      {
        id: 'lab-002',
        labName: 'Norwegian Veterinary Institute',
        sampleDate: twoWeeksAgo,
        resultDate: weekAgo,
        testType: 'PCR + Culture',
        result: 'Positive for Renibacterium salmoninarum',
        interpretation: 'Confirmed BKD infection',
      },
    ],
    immediateActions: [
      'Culled severely affected fish',
      'Implemented antibiotic treatment',
      'Enhanced biosecurity',
    ],
    quarantineMeasures: [
      'Site-wide movement ban',
      'All equipment sterilized',
      'No fish movements for 60 days',
    ],
    veterinarianNotified: true,
    veterinarianName: 'Dr. Anders Johansen',
    acknowledgement: {
      acknowledgedAt: twoWeeksAgo,
      acknowledgedBy: 'Mattilsynet Hordaland',
      referenceNumber: 'MT-2026-00098',
    },
    resolvedAt: threeDaysAgo,
    resolutionNotes: 'Treatment completed successfully. Mortality rates returned to normal. Quarantine lifted after negative follow-up tests.',
  },
];

/**
 * Get disease outbreaks by status
 */
export function getDiseaseOutbreaksByStatus(status: DiseaseStatus): DiseaseOutbreakReport[] {
  return mockDiseaseOutbreaks.filter((outbreak) => outbreak.diseaseStatus === status);
}

/**
 * Get disease outbreaks by category
 */
export function getDiseaseOutbreaksByCategory(category: 'A' | 'C' | 'F'): DiseaseOutbreakReport[] {
  return mockDiseaseOutbreaks.filter((outbreak) => outbreak.disease.category === category);
}

/**
 * Get active (unresolved) disease outbreaks
 */
export function getActiveDiseaseOutbreaks(): DiseaseOutbreakReport[] {
  return mockDiseaseOutbreaks.filter(
    (outbreak) => outbreak.diseaseStatus !== 'resolved'
  );
}
