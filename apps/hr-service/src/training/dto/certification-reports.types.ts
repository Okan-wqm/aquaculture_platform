import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { CertificationCategory } from '../entities/certification-type.entity';

/**
 * GraphQL read-model object types for certification/training reports and status
 * queries. These are projection view-models (no @Entity) assembled by the query
 * handlers from the underlying CertificationType / EmployeeCertification /
 * TrainingCourse / TrainingEnrollment tables. Field/shape mirrors the FE
 * selection sets in web/modules/hr-module/src/graphql/certification.operations.ts.
 */

// ---------------------------------------------------------------------------
// CertificationComplianceReport
// ---------------------------------------------------------------------------
@ObjectType()
export class CertificationCategoryCompliance {
  @Field(() => CertificationCategory)
  category!: CertificationCategory;

  @Field(() => Int)
  totalRequired!: number;

  @Field(() => Int)
  totalCertified!: number;

  @Field(() => Float)
  complianceRate!: number;

  @Field(() => Int)
  expiringCount!: number;
}

@ObjectType()
export class CertificationComplianceReport {
  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => Int)
  compliantEmployees!: number;

  @Field(() => Int)
  nonCompliantEmployees!: number;

  @Field(() => Float)
  complianceRate!: number;

  @Field(() => Int)
  expiringWithin30Days!: number;

  @Field(() => Int)
  expiringWithin60Days!: number;

  @Field(() => Int)
  expiringWithin90Days!: number;

  @Field(() => Int)
  expiredCount!: number;

  @Field(() => [CertificationCategoryCompliance])
  byCategory!: CertificationCategoryCompliance[];
}

// ---------------------------------------------------------------------------
// EmployeeCertificationStatus
// ---------------------------------------------------------------------------
@ObjectType()
export class ExpiringCertificationSummary {
  @Field(() => ID)
  certificationTypeId!: string;

  @Field()
  certificationTypeName!: string;

  @Field()
  expiryDate!: string;

  @Field(() => Int)
  daysUntilExpiry!: number;
}

@ObjectType()
export class MissingCertificationSummary {
  @Field(() => ID)
  certificationTypeId!: string;

  @Field()
  certificationTypeName!: string;

  @Field(() => CertificationCategory)
  category!: CertificationCategory;

  @Field()
  isMandatory!: boolean;

  @Field()
  requiredForOffshore!: boolean;
}

@ObjectType()
export class EmployeeCertificationStatus {
  @Field()
  isFullyCompliant!: boolean;

  @Field(() => Int)
  totalRequired!: number;

  @Field(() => Int)
  totalHeld!: number;

  @Field(() => [ExpiringCertificationSummary])
  expiringSoon!: ExpiringCertificationSummary[];

  @Field(() => [MissingCertificationSummary])
  missing!: MissingCertificationSummary[];
}

// ---------------------------------------------------------------------------
// MandatoryTrainingStatus
// ---------------------------------------------------------------------------
@ObjectType()
export class MandatoryTrainingStatus {
  @Field(() => ID)
  courseId!: string;

  @Field()
  courseName!: string;

  @Field()
  isMandatory!: boolean;

  // 'completed' | 'in_progress' | 'not_started' | 'overdue'
  @Field()
  status!: string;

  @Field({ nullable: true })
  completedAt?: string;

  @Field({ nullable: true })
  dueDate?: string;

  @Field(() => Int, { nullable: true })
  daysOverdue?: number;
}

// ---------------------------------------------------------------------------
// BulkEnrollInTraining result
// ---------------------------------------------------------------------------
@ObjectType()
export class BulkEnrollResult {
  @Field(() => Int)
  enrolled!: number;

  @Field(() => Int)
  alreadyEnrolled!: number;

  @Field(() => Int)
  failed!: number;

  @Field(() => [String])
  errors!: string[];
}
