import { Resolver, Query, Mutation, Args, ID, Context, Int, Float, ObjectType } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { RolesGuard } from '@aquaculture/backend-common/guards';
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
  GetExpiredCertificationsQuery,
  GetAllCertificationsQuery,
  GetTrainingCoursesQuery,
  GetTrainingEnrollmentsQuery,
} from './queries';

@ObjectType()
class TrainingCourseConnection extends StandardPaginatedResponse(TrainingCourse) {}

@ObjectType()
class EmployeeCertificationConnection extends StandardPaginatedResponse(EmployeeCertification) {}

@ObjectType()
class TrainingEnrollmentConnection extends StandardPaginatedResponse(TrainingEnrollment) {}

// SECURITY: Context only exposes JWT-verified user fields.
// Do NOT add x-tenant-id or x-user-id headers here — those are attacker-controlled
// and must never be used directly (LOW-01).
interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

@UseGuards(GqlAuthGuard)
@Resolver()
export class TrainingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified tenantId, never trust headers directly
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required - authentication required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified userId, never trust headers directly
    const userId = context.req.user?.sub;
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedException('User ID is required - authentication required');
    }
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

  @Query(() => [EmployeeCertification], { name: 'expiredCertifications' })
  async getExpiredCertifications(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<EmployeeCertification[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetExpiredCertificationsQuery(tenantId, departmentId),
    );
  }

  // =====================
  // All Certifications (Paginated)
  // =====================
  @Query(() => EmployeeCertificationConnection, { name: 'allCertifications' })
  async getAllCertifications(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => CertificationStatus, nullable: true }) status?: CertificationStatus,
    @Args('category', { type: () => CertificationCategory, nullable: true }) category?: CertificationCategory,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('certificationTypeId', { type: () => ID, nullable: true }) certificationTypeId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<EmployeeCertification>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetAllCertificationsQuery(tenantId, employeeId, certificationTypeId, status, category, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  // =====================
  // Training Course Queries
  // =====================
  @Query(() => TrainingCourseConnection, { name: 'trainingCourses' })
  async getTrainingCourses(
    @Context() context: GraphQLContext,
    @Args('trainingType', { type: () => TrainingType, nullable: true }) trainingType?: TrainingType,
    @Args('isMandatory', { nullable: true }) isMandatory?: boolean,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<TrainingCourse>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetTrainingCoursesQuery(tenantId, trainingType, isMandatory, isActive, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  // =====================
  // Training Enrollment Queries
  // =====================
  @Query(() => TrainingEnrollmentConnection, { name: 'trainingEnrollments' })
  async getTrainingEnrollments(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('trainingCourseId', { type: () => ID, nullable: true }) trainingCourseId?: string,
    @Args('status', { type: () => EnrollmentStatus, nullable: true }) status?: EnrollmentStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<TrainingEnrollment>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetTrainingEnrollmentsQuery(tenantId, employeeId, trainingCourseId, status, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [TrainingEnrollment], { name: 'myTrainingEnrollments' })
  async getMyTrainingEnrollments(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => EnrollmentStatus, nullable: true }) status?: EnrollmentStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<TrainingEnrollment[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const result = await this.queryBus.execute(
      new GetTrainingEnrollmentsQuery(tenantId, userId, undefined, status, limit, page),
    );
    return result.data;
  }

  // =====================
  // Certification Mutations
  // =====================
  @Mutation(() => EmployeeCertification)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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

    // Managers and admins (already verified by @Roles guard above) are allowed
    // to enroll other employees in training courses.
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
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
