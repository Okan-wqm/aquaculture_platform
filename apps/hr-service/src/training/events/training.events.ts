import { EmployeeCertification } from '../entities/employee-certification.entity';
import { TrainingEnrollment } from '../entities/training-enrollment.entity';

/**
 * Base class for certification events
 */
export abstract class CertificationEvent {
  constructor(public readonly certification: EmployeeCertification) {}

  get certificationId(): string {
    return this.certification.id;
  }

  get employeeId(): string {
    return this.certification.employeeId;
  }

  get tenantId(): string {
    return this.certification.tenantId;
  }
}

/**
 * Event published when a certification is added to an employee
 */
export class CertificationAddedEvent extends CertificationEvent {
  readonly eventType = 'certification.added';
}

/**
 * Event published when a certification is revoked
 */
export class CertificationRevokedEvent extends CertificationEvent {
  readonly eventType = 'certification.revoked';
}

/**
 * Base class for training events
 */
export abstract class TrainingEvent {
  constructor(public readonly enrollment: TrainingEnrollment) {}

  get enrollmentId(): string {
    return this.enrollment.id;
  }

  get employeeId(): string {
    return this.enrollment.employeeId;
  }

  get tenantId(): string {
    return this.enrollment.tenantId;
  }
}

/**
 * Event published when an employee completes a training course
 */
export class TrainingCompletedEvent extends TrainingEvent {
  readonly eventType = 'training.completed';

  get passed(): boolean {
    return this.enrollment.status === 'PASSED' || this.enrollment.status === 'COMPLETED';
  }

  get finalScore(): number | undefined {
    return this.enrollment.finalScore;
  }
}
