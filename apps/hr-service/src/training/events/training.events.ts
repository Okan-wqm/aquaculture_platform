import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type {
  TrainingCompletedEvent as TrainingCompletedEventContract,
  CertificationAddedEvent as CertificationAddedEventContract,
} from '@platform/event-contracts';
import { EmployeeCertification } from '../entities/employee-certification.entity';
import { TrainingEnrollment, EnrollmentStatus } from '../entities/training-enrollment.entity';

/**
 * HR-MEDIUM-007: Training/certification events now extend BaseEvent via
 * createBaseEvent(). The old class-based events were plain objects missing
 * eventId, timestamp, version, tenantId. Invalid events are STRUCTURALLY
 * IMPOSSIBLE — the factory enforces all required BaseEvent fields.
 */

/**
 * Create a flat CertificationAddedEvent conforming to the event-contracts interface.
 * Uses createBaseEvent() to guarantee all BaseEvent fields are present.
 */
export function createCertificationAddedEvent(
  certification: EmployeeCertification,
): CertificationAddedEventContract {
  return {
    ...createBaseEvent<CertificationAddedEventContract>(
      'CertificationAdded',
      certification.tenantId,
    ),
    eventType: 'CertificationAdded' as const,
    aggregateId: certification.id,
    aggregateType: 'EmployeeCertification',
    certificationId: certification.id,
    employeeId: certification.employeeId,
    certificationTypeId: certification.certificationTypeId,
    certificationTypeName: certification.certificationType?.name ?? 'Unknown',
    issueDate: toEventIso(certification.issueDate),
    expiryDate: toEventIso(certification.expiryDate),
  };
}

/**
 * Create a flat TrainingCompletedEvent conforming to the event-contracts interface.
 * Uses createBaseEvent() to guarantee all BaseEvent fields are present.
 */
export function createTrainingCompletedEvent(
  enrollment: TrainingEnrollment,
): TrainingCompletedEventContract {
  const passed =
    enrollment.status === EnrollmentStatus.PASSED ||
    enrollment.status === EnrollmentStatus.COMPLETED;

  return {
    ...createBaseEvent<TrainingCompletedEventContract>(
      'TrainingCompleted',
      enrollment.tenantId,
    ),
    eventType: 'TrainingCompleted' as const,
    aggregateId: enrollment.id,
    aggregateType: 'TrainingEnrollment',
    enrollmentId: enrollment.id,
    employeeId: enrollment.employeeId,
    trainingCourseId: enrollment.trainingCourseId,
    trainingCourseName: enrollment.trainingCourse?.name ?? 'Unknown',
    completedAt: toEventIso(enrollment.completedAt ?? new Date()),
    score: enrollment.finalScore,
    passed,
  };
}

/**
 * Create a flat CertificationRevokedEvent conforming to the event-contracts interface.
 * Uses createBaseEvent() to guarantee all BaseEvent fields are present.
 */
export function createCertificationRevokedEvent(
  certification: EmployeeCertification,
): import('@platform/event-contracts').CertificationRevokedEvent {
  return {
    ...createBaseEvent('CertificationRevoked', certification.tenantId),
    eventType: 'CertificationRevoked' as const,
    aggregateId: certification.id,
    aggregateType: 'EmployeeCertification',
    certificationId: certification.id,
    employeeId: certification.employeeId,
    certificationTypeName: certification.certificationType?.name ?? 'Unknown',
    revokedBy: certification.revokedBy ?? 'unknown',
    reason: certification.revocationReason ?? '',
  } as import('@platform/event-contracts').CertificationRevokedEvent;
}

/**
 * @deprecated Use createCertificationAddedEvent() factory function instead.
 * Kept temporarily for backward compatibility with existing event handlers
 * that may reference the class name. Will be removed in next major version.
 */
export class CertificationAddedEvent {
  readonly eventType = 'CertificationAdded';
  constructor(public readonly certification: EmployeeCertification) {}
}

/**
 * @deprecated Use createCertificationRevokedEvent() factory function instead.
 */
export class CertificationRevokedEvent {
  readonly eventType = 'CertificationRevoked';
  constructor(public readonly certification: EmployeeCertification) {}
}

/**
 * @deprecated Use createTrainingCompletedEvent() factory function instead.
 */
export class TrainingCompletedEvent {
  readonly eventType = 'TrainingCompleted';
  constructor(public readonly enrollment: TrainingEnrollment) {}
}
