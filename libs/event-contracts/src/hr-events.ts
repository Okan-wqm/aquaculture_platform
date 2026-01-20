import { BaseEvent } from './base-event';

/**
 * Employee Created Event
 */
export interface EmployeeCreatedEvent extends BaseEvent {
  eventType: 'EmployeeCreated';
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  position: string;
  farmId?: string;
  hireDate: Date;
}

/**
 * Employee Updated Event
 */
export interface EmployeeUpdatedEvent extends BaseEvent {
  eventType: 'EmployeeUpdated';
  employeeId: string;
  changes: Record<string, unknown>;
}

/**
 * Employee Terminated Event
 */
export interface EmployeeTerminatedEvent extends BaseEvent {
  eventType: 'EmployeeTerminated';
  employeeId: string;
  terminationDate: Date;
  reason?: string;
}

/**
 * Payroll Processed Event
 */
export interface PayrollProcessedEvent extends BaseEvent {
  eventType: 'PayrollProcessed';
  payrollId: string;
  employeeId: string;
  periodStart: Date;
  periodEnd: Date;
  grossAmount: number;
  netAmount: number;
  status: 'draft' | 'approved' | 'paid';
}

/**
 * Leave Requested Event
 */
export interface LeaveRequestedEvent extends BaseEvent {
  eventType: 'LeaveRequested';
  leaveId: string;
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  reason?: string;
}

/**
 * Leave Approved Event
 */
export interface LeaveApprovedEvent extends BaseEvent {
  eventType: 'LeaveApproved';
  leaveId: string;
  employeeId: string;
  approvedBy: string;
}

/**
 * Attendance Recorded Event
 */
export interface AttendanceRecordedEvent extends BaseEvent {
  eventType: 'AttendanceRecorded';
  employeeId: string;
  farmId?: string;
  clockIn?: Date;
  clockOut?: Date;
  hoursWorked?: number;
}

// =====================
// Leave Events
// =====================

/**
 * Leave Request Submitted Event
 */
export interface LeaveRequestSubmittedEvent extends BaseEvent {
  eventType: 'LeaveRequestSubmitted';
  leaveRequestId: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
}

/**
 * Leave Request Rejected Event
 */
export interface LeaveRejectedEvent extends BaseEvent {
  eventType: 'LeaveRejected';
  leaveRequestId: string;
  employeeId: string;
  rejectedBy: string;
  reason: string;
}

/**
 * Leave Request Cancelled Event
 */
export interface LeaveCancelledEvent extends BaseEvent {
  eventType: 'LeaveCancelled';
  leaveRequestId: string;
  employeeId: string;
  cancelledBy: string;
  reason?: string;
}

// =====================
// Attendance Events
// =====================

/**
 * Employee Clocked In Event
 */
export interface EmployeeClockedInEvent extends BaseEvent {
  eventType: 'EmployeeClockedIn';
  attendanceRecordId: string;
  employeeId: string;
  clockInTime: Date;
  clockInMethod: string;
  workAreaId?: string;
  isOffshore: boolean;
  location?: {
    latitude: number;
    longitude: number;
  };
}

/**
 * Employee Clocked Out Event
 */
export interface EmployeeClockedOutEvent extends BaseEvent {
  eventType: 'EmployeeClockedOut';
  attendanceRecordId: string;
  employeeId: string;
  clockOutTime: Date;
  workedMinutes: number;
  overtimeMinutes: number;
}

// =====================
// Certification Events
// =====================

/**
 * Certification Added Event
 */
export interface CertificationAddedEvent extends BaseEvent {
  eventType: 'CertificationAdded';
  certificationId: string;
  employeeId: string;
  certificationTypeId: string;
  certificationTypeName: string;
  issueDate: Date;
  expiryDate?: Date;
}

/**
 * Certification Expiring Soon Event
 */
export interface CertificationExpiringSoonEvent extends BaseEvent {
  eventType: 'CertificationExpiringSoon';
  certificationId: string;
  employeeId: string;
  employeeName: string;
  certificationTypeName: string;
  expiryDate: Date;
  daysUntilExpiry: number;
}

/**
 * Certification Expired Event
 */
export interface CertificationExpiredEvent extends BaseEvent {
  eventType: 'CertificationExpired';
  certificationId: string;
  employeeId: string;
  employeeName: string;
  certificationTypeName: string;
  expiryDate: Date;
}

/**
 * Certification Revoked Event
 */
export interface CertificationRevokedEvent extends BaseEvent {
  eventType: 'CertificationRevoked';
  certificationId: string;
  employeeId: string;
  certificationTypeName: string;
  revokedBy: string;
  reason: string;
}

// =====================
// Training Events
// =====================

/**
 * Training Completed Event
 */
export interface TrainingCompletedEvent extends BaseEvent {
  eventType: 'TrainingCompleted';
  enrollmentId: string;
  employeeId: string;
  trainingCourseId: string;
  trainingCourseName: string;
  completedAt: Date;
  score?: number;
  passed: boolean;
}

/**
 * Mandatory Training Overdue Event
 */
export interface MandatoryTrainingOverdueEvent extends BaseEvent {
  eventType: 'MandatoryTrainingOverdue';
  enrollmentId: string;
  employeeId: string;
  employeeName: string;
  trainingCourseName: string;
  dueDate: Date;
  daysOverdue: number;
}

// =====================
// Work Rotation Events
// =====================

/**
 * Employee Rotation Started Event
 */
export interface EmployeeRotationStartedEvent extends BaseEvent {
  eventType: 'EmployeeRotationStarted';
  rotationId: string;
  employeeId: string;
  workAreaId: string;
  workAreaName: string;
  rotationType: string;
  startDate: Date;
  endDate: Date;
  daysOn: number;
  daysOff: number;
}

/**
 * Employee Rotation Ended Event
 */
export interface EmployeeRotationEndedEvent extends BaseEvent {
  eventType: 'EmployeeRotationEnded';
  rotationId: string;
  employeeId: string;
  workAreaId: string;
  actualEndTime: Date;
  wasExtended: boolean;
}

/**
 * Rotation Check-In Event
 */
export interface RotationCheckInEvent extends BaseEvent {
  eventType: 'RotationCheckIn';
  rotationId: string;
  employeeId: string;
  checkInTime: Date;
  location?: {
    latitude: number;
    longitude: number;
  };
}

// =====================
// Performance Events
// =====================

/**
 * Performance Review Finalized Event
 */
export interface PerformanceReviewFinalizedEvent extends BaseEvent {
  eventType: 'PerformanceReviewFinalized';
  reviewId: string;
  employeeId: string;
  reviewerId: string;
  reviewPeriodStart: Date;
  reviewPeriodEnd: Date;
  overallRating: number;
  finalizedAt: Date;
}

/**
 * Goal Completed Event
 */
export interface GoalCompletedEvent extends BaseEvent {
  eventType: 'GoalCompleted';
  goalId: string;
  employeeId: string;
  goalTitle: string;
  completedAt: Date;
  progressPercent: number;
}

// =====================
// Type Union
// =====================

export type HREvent =
  | EmployeeCreatedEvent
  | EmployeeUpdatedEvent
  | EmployeeTerminatedEvent
  | PayrollProcessedEvent
  | LeaveRequestedEvent
  | LeaveApprovedEvent
  | LeaveRequestSubmittedEvent
  | LeaveRejectedEvent
  | LeaveCancelledEvent
  | AttendanceRecordedEvent
  | EmployeeClockedInEvent
  | EmployeeClockedOutEvent
  | CertificationAddedEvent
  | CertificationExpiringSoonEvent
  | CertificationExpiredEvent
  | CertificationRevokedEvent
  | TrainingCompletedEvent
  | MandatoryTrainingOverdueEvent
  | EmployeeRotationStartedEvent
  | EmployeeRotationEndedEvent
  | RotationCheckInEvent
  | PerformanceReviewFinalizedEvent
  | GoalCompletedEvent;
