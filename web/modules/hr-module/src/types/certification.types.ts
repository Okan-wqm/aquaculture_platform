/**
 * Certification & Training domain types
 * Includes aquaculture-specific certifications (diving, safety, vessel operations)
 */

import type { BaseEntity, PaginatedResponse } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum CertificationCategory {
  DIVING = 'diving',
  SAFETY = 'safety',
  VESSEL = 'vessel',
  EQUIPMENT = 'equipment',
  FIRST_AID = 'first_aid',
  FIRE_SAFETY = 'fire_safety',
  CHEMICAL_HANDLING = 'chemical_handling',
  FISH_HANDLING = 'fish_handling',
  WATER_QUALITY = 'water_quality',
  LEADERSHIP = 'leadership',
  TECHNICAL = 'technical',
  OTHER = 'other',
}

export enum CertificationStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  PENDING_RENEWAL = 'pending_renewal',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
}

export enum TrainingDeliveryMethod {
  IN_PERSON = 'in_person',
  ONLINE = 'online',
  HYBRID = 'hybrid',
  ON_THE_JOB = 'on_the_job',
  SELF_PACED = 'self_paced',
}

export enum EnrollmentStatus {
  ENROLLED = 'enrolled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  WITHDRAWN = 'withdrawn',
  NO_SHOW = 'no_show',
}

// =====================
// Interfaces
// =====================

export interface CertificationType extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  category: CertificationCategory;
  issuingAuthority?: string;
  validityMonths: number;
  renewalReminderDays: number;
  isMandatory: boolean;
  requiredForOffshore: boolean;
  requiredForDiving: boolean;
  requiredForVessel: boolean;
  prerequisiteCertificationIds: string[];
  prerequisites?: CertificationType[];
  displayOrder: number;
  isActive: boolean;
}

export interface EmployeeCertification extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  certificationTypeId: string;
  certificationType?: CertificationType;
  certificateNumber?: string;
  issuedDate: string;
  expiryDate?: string;
  issuedBy?: string;
  status: CertificationStatus;
  verifiedBy?: string;
  verifiedAt?: string;
  verificationNotes?: string;
  attachmentUrl?: string;
  reminderSentAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface TrainingCourse extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  category: CertificationCategory;
  deliveryMethod: TrainingDeliveryMethod;
  durationHours: number;
  maxParticipants?: number;
  passingScore?: number;
  certificationTypeId?: string;
  certificationType?: CertificationType;
  prerequisiteCourseIds: string[];
  prerequisites?: TrainingCourse[];
  isMandatory: boolean;
  refresherMonths?: number;
  isActive: boolean;
}

export interface TrainingEnrollment extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  courseId: string;
  course?: TrainingCourse;
  enrolledAt: string;
  startedAt?: string;
  completedAt?: string;
  status: EnrollmentStatus;
  score?: number;
  passed?: boolean;
  feedback?: string;
  instructorNotes?: string;
  certificateIssuedAt?: string;
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
  issuingAuthority?: string;
  validityMonths: number;
  renewalReminderDays?: number;
  isMandatory?: boolean;
  requiredForOffshore?: boolean;
  requiredForDiving?: boolean;
  requiredForVessel?: boolean;
  prerequisiteCertificationIds?: string[];
}

export interface AddEmployeeCertificationInput {
  employeeId: string;
  certificationTypeId: string;
  certificateNumber?: string;
  issuedDate: string;
  expiryDate?: string;
  issuedBy?: string;
  attachmentUrl?: string;
}

export interface VerifyCertificationInput {
  id: string;
  verificationNotes?: string;
}

export interface RevokeCertificationInput {
  id: string;
  reason: string;
}

export interface CreateTrainingCourseInput {
  code: string;
  name: string;
  description?: string;
  category: CertificationCategory;
  deliveryMethod: TrainingDeliveryMethod;
  durationHours: number;
  maxParticipants?: number;
  passingScore?: number;
  certificationTypeId?: string;
  prerequisiteCourseIds?: string[];
  isMandatory?: boolean;
  refresherMonths?: number;
}

export interface EnrollInTrainingInput {
  employeeId: string;
  courseId: string;
}

export interface CompleteTrainingInput {
  enrollmentId: string;
  score?: number;
  passed: boolean;
  feedback?: string;
  instructorNotes?: string;
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
  courseId?: string;
  category?: CertificationCategory;
  status?: EnrollmentStatus;
  isMandatory?: boolean;
}

// =====================
// Response Types
// =====================

export type CertificationTypeConnection = PaginatedResponse<CertificationType>;
export type EmployeeCertificationConnection = PaginatedResponse<EmployeeCertification>;
export type TrainingCourseConnection = PaginatedResponse<TrainingCourse>;
export type TrainingEnrollmentConnection = PaginatedResponse<TrainingEnrollment>;

// =====================
// Display Helpers
// =====================

export const CERTIFICATION_CATEGORY_CONFIG: Record<CertificationCategory, { label: string; icon: string }> = {
  [CertificationCategory.DIVING]: { label: 'Diving', icon: 'Waves' },
  [CertificationCategory.SAFETY]: { label: 'Safety', icon: 'Shield' },
  [CertificationCategory.VESSEL]: { label: 'Vessel Operations', icon: 'Ship' },
  [CertificationCategory.EQUIPMENT]: { label: 'Equipment', icon: 'Wrench' },
  [CertificationCategory.FIRST_AID]: { label: 'First Aid', icon: 'Heart' },
  [CertificationCategory.FIRE_SAFETY]: { label: 'Fire Safety', icon: 'Flame' },
  [CertificationCategory.CHEMICAL_HANDLING]: { label: 'Chemical Handling', icon: 'Flask' },
  [CertificationCategory.FISH_HANDLING]: { label: 'Fish Handling', icon: 'Fish' },
  [CertificationCategory.WATER_QUALITY]: { label: 'Water Quality', icon: 'Droplet' },
  [CertificationCategory.LEADERSHIP]: { label: 'Leadership', icon: 'Users' },
  [CertificationCategory.TECHNICAL]: { label: 'Technical', icon: 'Settings' },
  [CertificationCategory.OTHER]: { label: 'Other', icon: 'FileText' },
};

export const CERTIFICATION_STATUS_CONFIG: Record<CertificationStatus, { label: string; variant: string }> = {
  [CertificationStatus.ACTIVE]: { label: 'Active', variant: 'success' },
  [CertificationStatus.EXPIRED]: { label: 'Expired', variant: 'error' },
  [CertificationStatus.PENDING_RENEWAL]: { label: 'Pending Renewal', variant: 'warning' },
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

export const TRAINING_DELIVERY_METHOD_LABELS: Record<TrainingDeliveryMethod, string> = {
  [TrainingDeliveryMethod.IN_PERSON]: 'In-Person',
  [TrainingDeliveryMethod.ONLINE]: 'Online',
  [TrainingDeliveryMethod.HYBRID]: 'Hybrid',
  [TrainingDeliveryMethod.ON_THE_JOB]: 'On-the-Job',
  [TrainingDeliveryMethod.SELF_PACED]: 'Self-Paced',
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
