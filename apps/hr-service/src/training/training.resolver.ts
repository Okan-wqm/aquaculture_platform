import { Resolver, Query, Mutation, Args, ID, Context, Int, Float } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CertificationType, CertificationCategory } from './entities/certification-type.entity';
import { EmployeeCertification, CertificationStatus } from './entities/employee-certification.entity';
import { TrainingCourse, TrainingType } from './entities/training-course.entity';
import { TrainingEnrollment, EnrollmentStatus } from './entities/training-enrollment.entity';
import {
  AddEmployeeCertificationCommand,
  VerifyCertificationCommand,
  RevokeCertificationCommand,
  EnrollInTrainingCommand,
  CompleteTrainingCommand,
} from './commands';
import {
  GetCertificationTypesQuery,
  GetEmployeeCertificationsQuery,
  GetExpiringCertificationsQuery,
  GetTrainingCoursesQuery,
  GetTrainingEnrollmentsQuery,
} from './queries';

interface GraphQLContext {
  req: {
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
    };
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

@Resolver()
export class TrainingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    const tenantId =
      context.req.user?.tenantId ||
      context.req.headers['x-tenant-id'];
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    const userId =
      context.req.user?.sub ||
      context.req.headers['x-user-id'] ||
      'system';
    return userId;
  }

  // =====================
  // Certification Type Queries
  // =====================
  @Query(() => [CertificationType], { name: 'certificationTypes' })
  async getCertificationTypes(
    @Context() context: GraphQLContext,
    @Args('category', { type: () => CertificationCategory, nullable: true }) category?: CertificationCategory,
    @Args('isActive', { nullable: true }) isActive?: boolean,
  ): Promise<CertificationType[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetCertificationTypesQuery(tenantId, category, isActive),
    );
  }

  // =====================
  // Employee Certification Queries
  // =====================
  @Query(() => [EmployeeCertification], { name: 'employeeCertifications' })
  async getEmployeeCertifications(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
    @Args('status', { type: () => CertificationStatus, nullable: true }) status?: CertificationStatus,
  ): Promise<EmployeeCertification[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetEmployeeCertificationsQuery(tenantId, employeeId, status),
    );
  }

  @Query(() => [EmployeeCertification], { name: 'myCertifications' })
  async getMyCertifications(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => CertificationStatus, nullable: true }) status?: CertificationStatus,
  ): Promise<EmployeeCertification[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetEmployeeCertificationsQuery(tenantId, userId, status),
    );
  }

  @Query(() => [EmployeeCertification], { name: 'expiringCertifications' })
  async getExpiringCertifications(
    @Context() context: GraphQLContext,
    @Args('daysUntilExpiry', { type: () => Int, defaultValue: 30 }) daysUntilExpiry: number,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<EmployeeCertification[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetExpiringCertificationsQuery(tenantId, daysUntilExpiry, departmentId),
    );
  }

  // =====================
  // Training Course Queries
  // =====================
  @Query(() => [TrainingCourse], { name: 'trainingCourses' })
  async getTrainingCourses(
    @Context() context: GraphQLContext,
    @Args('trainingType', { type: () => TrainingType, nullable: true }) trainingType?: TrainingType,
    @Args('isMandatory', { nullable: true }) isMandatory?: boolean,
    @Args('isActive', { nullable: true }) isActive?: boolean,
  ): Promise<TrainingCourse[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetTrainingCoursesQuery(tenantId, trainingType, isMandatory, isActive),
    );
  }

  // =====================
  // Training Enrollment Queries
  // =====================
  @Query(() => [TrainingEnrollment], { name: 'trainingEnrollments' })
  async getTrainingEnrollments(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('trainingCourseId', { type: () => ID, nullable: true }) trainingCourseId?: string,
    @Args('status', { type: () => EnrollmentStatus, nullable: true }) status?: EnrollmentStatus,
  ): Promise<TrainingEnrollment[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetTrainingEnrollmentsQuery(tenantId, employeeId, trainingCourseId, status),
    );
  }

  @Query(() => [TrainingEnrollment], { name: 'myTrainingEnrollments' })
  async getMyTrainingEnrollments(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => EnrollmentStatus, nullable: true }) status?: EnrollmentStatus,
  ): Promise<TrainingEnrollment[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetTrainingEnrollmentsQuery(tenantId, userId, undefined, status),
    );
  }

  // =====================
  // Certification Mutations
  // =====================
  @Mutation(() => EmployeeCertification)
  async addEmployeeCertification(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('certificationTypeId', { type: () => ID }) certificationTypeId: string,
    @Args('issueDate') issueDate: string,
    @Context() context: GraphQLContext,
    @Args('expiryDate', { nullable: true }) expiryDate?: string,
    @Args('issuingAuthority', { nullable: true }) issuingAuthority?: string,
    @Args('externalCertificationId', { nullable: true }) externalCertificationId?: string,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<EmployeeCertification> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new AddEmployeeCertificationCommand(
        tenantId,
        userId,
        employeeId,
        certificationTypeId,
        issueDate,
        expiryDate,
        issuingAuthority,
        externalCertificationId,
        notes,
      ),
    );
  }

  @Mutation(() => EmployeeCertification)
  async verifyCertification(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<EmployeeCertification> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new VerifyCertificationCommand(tenantId, userId, id, notes),
    );
  }

  @Mutation(() => EmployeeCertification)
  async revokeCertification(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<EmployeeCertification> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new RevokeCertificationCommand(tenantId, userId, id, reason),
    );
  }

  // =====================
  // Training Enrollment Mutations
  // =====================
  @Mutation(() => TrainingEnrollment)
  async enrollInTraining(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('trainingCourseId', { type: () => ID }) trainingCourseId: string,
    @Context() context: GraphQLContext,
    @Args('dueDate', { nullable: true }) dueDate?: string,
    @Args('sessionId', { nullable: true }) sessionId?: string,
    @Args('instructor', { nullable: true }) instructor?: string,
    @Args('location', { nullable: true }) location?: string,
  ): Promise<TrainingEnrollment> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new EnrollInTrainingCommand(
        tenantId,
        userId,
        employeeId,
        trainingCourseId,
        dueDate,
        sessionId,
        instructor,
        location,
      ),
    );
  }

  @Mutation(() => TrainingEnrollment)
  async completeTraining(
    @Args('enrollmentId', { type: () => ID }) enrollmentId: string,
    @Context() context: GraphQLContext,
    @Args('score', { type: () => Float, nullable: true }) score?: number,
    @Args('feedback', { nullable: true }) feedback?: string,
    @Args('feedbackRating', { type: () => Int, nullable: true }) feedbackRating?: number,
  ): Promise<TrainingEnrollment> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CompleteTrainingCommand(
        tenantId,
        userId,
        enrollmentId,
        score,
        feedback,
        feedbackRating,
      ),
    );
  }
}
