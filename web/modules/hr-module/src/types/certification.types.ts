/**
 * Certification & Training domain types
 * Includes aquaculture-specific certifications (diving, safety, vessel operations)
 */

import type { PaginationResultV1 } from '@platform/pagination-contracts';
import type { BaseEntity } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum CertificationCategory {
  DIVING = 'DIVING',
  SAFETY = 'SAFETY',
  VESSEL = 'VESSEL',
  EQUIPMENT = 'EQUIPMENT',
  FIRST_AID = 'FIRST_AID',
  FOOD_HANDLING = 'FOOD_HANDLING',
  ENVIRONMENTAL = 'ENVIRONMENTAL',
  MANAGEMENT = 'MANAGEMENT',
  TECHNICAL = 'TECHNICAL',
  OTHER = 'OTHER',
}

export enum CertificationStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  PENDING = 'PENDING',
  EXPIRING_SOON = 'EXPIRING_SOON',
  SUSPENDED = 'SUSPENDED',
  REVOKED = 'REVOKED',
}

export enum VerificationStatus {
  UNVERIFIED = 'UNVERIFIED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
}

export enum CertificationRequirement {
  MANDATORY = 'MANDATORY',
  RECOMMENDED = 'RECOMMENDED',
  OPTIONAL = 'OPTIONAL',
}

export enum EnrollmentStatus {
  ENROLLED = 'ENROLLED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  WITHDRAWN = 'WITHDRAWN',
  NO_SHOW = 'NO_SHOW',
}

// =====================
// Interfaces
// =====================

export interface CertificationType extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  category: CertificationCategory;
  requirement: CertificationRequirement;
  issuingAuthority?: string;
  validityMonths?: number;
  renewalReminderDays?: number;
  requiresRenewal: boolean;
  requiresPhysicalAssessment: boolean;
  isOffshoreRequired: boolean;
  isDivingRequired: boolean;
  applicableWorkAreas?: string[];
  prerequisiteCertifications?: string[];
  colorCode?: string;
  displayOrder: number;
  isActive: boolean;
}

export interface EmployeeCertification extends BaseEntity {
  employeeId: string;
  // Relations — populated only when query handler uses leftJoinAndSelect
  employee?: Employee;
  certificationTypeId: string;
  certificationType?: CertificationType;
  certificationNumber: string;
  issueDate: string;
  expiryDate?: string;
  daysUntilExpiry?: number;
  status: CertificationStatus;
  verificationStatus: VerificationStatus;
  verifiedBy?: string;
  verifiedAt?: string;
  issuingAuthority?: string;
  externalCertificationId?: string;
  notes?: string;
  documents?: {
    documentId: string;
    fileName: string;
    uploadedAt: string;
    documentType?: string;
  }[];
  revokedBy?: string;
  revokedAt?: string;
  revocationReason?: string;
  previousCertificationId?: string;
  isRenewal: boolean;
  reminderSent: boolean;
  reminderSentAt?: string;
}

export interface TrainingCourse extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  trainingType: string;
  level: string;
  durationMinutes: number;
  maxAttempts?: number;
  passingScore?: number;
  certificationTypeId?: string;
  prerequisites: string[];
  isMandatory: boolean;
  validityMonths?: number;
  isActive: boolean;
}

export interface TrainingEnrollment extends BaseEntity {
  employeeId: string;
  trainingCourseId: string;
  status: EnrollmentStatus;
  enrollmentDate: string;
  dueDate?: string;
  startedAt?: string;
  completedAt?: string;
  progressPercent: number;
  finalScore?: number;
  attemptCount: number;
  assessmentAttempts?: {
    attemptNumber: number;
    score: number;
    passed: boolean;
    attemptedAt: string;
    durationMinutes?: number;
  }[];
  certificateId?: string;
  sessionId?: string;
  instructor?: string;
  location?: string;
  feedback?: string;
  feedbackRating?: number;
  notes?: string;
}

export interface CertificationComplianceReport {
  totalEmployees: number;
  compliantEmployees: number;
  nonCompliantEmployees: number;
  complianceRate: number;
  expiringWithin30Days: number;
  expiringWithin60Days: number;
  expiringWithin90Days: number;
  expiredCount: number;
  byCategory: CertificationCategoryStats[];
}

export interface CertificationCategoryStats {
  category: CertificationCategory;
  totalRequired: number;
  totalCertified: number;
  complianceRate: number;
  expiringCount: number;
}

export interface MandatoryTrainingStatus {
  courseId: string;
  courseName: string;
  isMandatory: boolean;
  status: 'completed' | 'in_progress' | 'not_started' | 'overdue';
  completedAt?: string;
  dueDate?: string;
  daysOverdue?: number;
}

export interface ExpiringCertificationAlert {
  certification: EmployeeCertification;
  daysUntilExpiry: number;
  urgencyLevel: 'low' | 'medium' | 'high' | 'critical';
}

// =====================
// Input Types
// =====================

export interface CreateCertificationTypeInput {
  code: string;
  name: string;
  description?: string;
  category: CertificationCategory;
  requirement?: CertificationRequirement;
  issuingAuthority?: string;
  validityMonths?: number;
  renewalReminderDays?: number;
  requiresRenewal?: boolean;
  requiresPhysicalAssessment?: boolean;
  isOffshoreRequired?: boolean;
  isDivingRequired?: boolean;
  applicableWorkAreas?: string[];
  prerequisiteCertifications?: string[];
}

export interface AddEmployeeCertificationInput {
  employeeId: string;
  certificationTypeId: string;
  certificationNumber?: string;
  issueDate: string;
  expiryDate?: string;
  issuingAuthority?: string;
}

export interface VerifyCertificationInput {
  id: string;
  notes?: string;
}

export interface RevokeCertificationInput {
  id: string;
  reason: string;
}

export interface CreateTrainingCourseInput {
  code: string;
  name: string;
  description?: string;
  trainingType: string;
  level: string;
  durationMinutes: number;
  maxAttempts?: number;
  passingScore?: number;
  certificationTypeId?: string;
  prerequisites?: string[];
  isMandatory?: boolean;
  validityMonths?: number;
}

export interface EnrollInTrainingInput {
  employeeId: string;
  trainingCourseId: string;
}

export interface CompleteTrainingInput {
  enrollmentId: string;
  score?: number;
  feedback?: string;
  feedbackRating?: number;
}

export interface CertificationFilterInput {
  employeeId?: string;
  certificationTypeId?: string;
  category?: CertificationCategory;
  status?: CertificationStatus;
  expiringWithinDays?: number;
}

export interface TrainingFilterInput {
  employeeId?: string;
  trainingCourseId?: string;
  trainingType?: string;
  status?: EnrollmentStatus;
  isMandatory?: boolean;
}

// =====================
// Response Types
// =====================

export type CertificationTypeConnection = PaginationResultV1<CertificationType>;
export type EmployeeCertificationConnection = PaginationResultV1<EmployeeCertification>;
export type TrainingCourseConnection = PaginationResultV1<TrainingCourse>;
export type TrainingEnrollmentConnection = PaginationResultV1<TrainingEnrollment>;

// =====================
// Display Helpers
// =====================

export const CERTIFICATION_CATEGORY_CONFIG: Record<CertificationCategory, { label: string; icon: string }> = {
  [CertificationCategory.DIVING]: { label: 'Diving', icon: 'Waves' },
  [CertificationCategory.SAFETY]: { label: 'Safety', icon: 'Shield' },
  [CertificationCategory.VESSEL]: { label: 'Vessel Operations', icon: 'Ship' },
  [CertificationCategory.EQUIPMENT]: { label: 'Equipment', icon: 'Wrench' },
  [CertificationCategory.FIRST_AID]: { label: 'First Aid', icon: 'Heart' },
  [CertificationCategory.FOOD_HANDLING]: { label: 'Food Handling', icon: 'UtensilsCrossed' },
  [CertificationCategory.ENVIRONMENTAL]: { label: 'Environmental', icon: 'Leaf' },
  [CertificationCategory.MANAGEMENT]: { label: 'Management', icon: 'Users' },
  [CertificationCategory.TECHNICAL]: { label: 'Technical', icon: 'Settings' },
  [CertificationCategory.OTHER]: { label: 'Other', icon: 'FileText' },
};

export const CERTIFICATION_STATUS_CONFIG: Record<CertificationStatus, { label: string; variant: string }> = {
  [CertificationStatus.ACTIVE]: { label: 'Active', variant: 'success' },
  [CertificationStatus.EXPIRED]: { label: 'Expired', variant: 'error' },
  [CertificationStatus.PENDING]: { label: 'Pending', variant: 'warning' },
  [CertificationStatus.EXPIRING_SOON]: { label: 'Expiring Soon', variant: 'warning' },
  [CertificationStatus.SUSPENDED]: { label: 'Suspended', variant: 'warning' },
  [CertificationStatus.REVOKED]: { label: 'Revoked', variant: 'error' },
};

export const ENROLLMENT_STATUS_CONFIG: Record<EnrollmentStatus, { label: string; variant: string }> = {
  [EnrollmentStatus.ENROLLED]: { label: 'Enrolled', variant: 'info' },
  [EnrollmentStatus.IN_PROGRESS]: { label: 'In Progress', variant: 'warning' },
  [EnrollmentStatus.COMPLETED]: { label: 'Completed', variant: 'success' },
  [EnrollmentStatus.FAILED]: { label: 'Failed', variant: 'error' },
  [EnrollmentStatus.WITHDRAWN]: { label: 'Withdrawn', variant: 'default' },
  [EnrollmentStatus.NO_SHOW]: { label: 'No Show', variant: 'error' },
};

/**
 * Get urgency level based on days until expiry
 */
export function getCertificationUrgency(daysUntilExpiry: number): 'low' | 'medium' | 'high' | 'critical' {
  if (daysUntilExpiry <= 0) return 'critical';
  if (daysUntilExpiry <= 14) return 'high';
  if (daysUntilExpiry <= 30) return 'medium';
  return 'low';
}
