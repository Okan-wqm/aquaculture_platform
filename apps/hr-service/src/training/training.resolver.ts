import { Resolver, Query, Mutation, Args, ID, Context, Int, Float, ObjectType } from '@nestjs/graphql';
import { NotFoundException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role, AuditLog, ModuleUserOrHigher } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CertificationType, CertificationCategory } from './entities/certification-type.entity';
import { EmployeeCertification, CertificationStatus } from './entities/employee-certification.entity';
import { TrainingCourse, TrainingType } from './entities/training-course.entity';
import { TrainingEnrollment, EnrollmentStatus } from './entities/training-enrollment.entity';
import { TrainingSession } from './entities/training-session.entity';
import { Employee } from '../hr/entities/employee.entity';
import { CreateCertificationTypeInput } from './dto/create-certification-type.input';
import { UpdateCertificationTypeInput } from './dto/update-certification-type.input';
import { CreateTrainingCourseInput } from './dto/create-training-course.input';
import { UpdateTrainingCourseInput } from './dto/update-training-course.input';
import {
  CertificationComplianceReport,
  EmployeeCertificationStatus,
  MandatoryTrainingStatus,
  BulkEnrollResult,
} from './dto/certification-reports.types';
import {
  AddEmployeeCertificationCommand,
  VerifyCertificationCommand,
  RevokeCertificationCommand,
  EnrollInTrainingCommand,
  CompleteTrainingCommand,
  CreateCertificationTypeCommand,
  UpdateCertificationTypeCommand,
  CreateTrainingCourseCommand,
  UpdateTrainingCourseCommand,
  RenewCertificationCommand,
  StartTrainingCommand,
  WithdrawFromTrainingCommand,
  BulkEnrollInTrainingCommand,
} from './commands';
import {
  GetCertificationTypesQuery,
  GetEmployeeCertificationsQuery,
  GetExpiringCertificationsQuery,
  GetExpiredCertificationsQuery,
  GetAllCertificationsQuery,
  GetTrainingCoursesQuery,
  GetTrainingEnrollmentsQuery,
  GetCertificationTypeQuery,
  GetTrainingCourseQuery,
  GetEmployeeCertificationStatusQuery,
  GetCertificationComplianceReportQuery,
  GetCertificationsForWorkAreaQuery,
  GetMandatoryTrainingStatusQuery,
  GetTrainingCalendarQuery,
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
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  /**
   * Resolve the calling user's own employee record id from the JWT subject.
   * Used by self-service mutations (startTraining / withdrawFromTraining) to bind
   * the action to the caller's employee so ownership can be enforced server-side.
   */
  private async resolveEmployeeId(userId: string, tenantId: string): Promise<string> {
    const employee = await this.employeeRepository.findOne({
      where: { userId, tenantId, isDeleted: false },
      select: ['id'],
    });
    if (!employee) {
      throw new NotFoundException(
        'Employee record not found for current user. Please contact your administrator.',
      );
    }
    return employee.id;
  }

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

  // =====================
  // Certification Type / Training Course detail queries
  // =====================
  @Query(() => CertificationType, { name: 'certificationType' })
  async getCertificationType(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<CertificationType> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetCertificationTypeQuery(tenantId, id));
  }

  @Query(() => TrainingCourse, { name: 'trainingCourse' })
  async getTrainingCourse(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<TrainingCourse> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetTrainingCourseQuery(tenantId, id));
  }

  // =====================
  // Compliance / status report queries
  // =====================
  @Query(() => EmployeeCertificationStatus, { name: 'employeeCertificationStatus' })
  async getEmployeeCertificationStatus(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
  ): Promise<EmployeeCertificationStatus> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetEmployeeCertificationStatusQuery(tenantId, employeeId),
    );
  }

  @Query(() => CertificationComplianceReport, { name: 'certificationComplianceReport' })
  @UseGuards(RolesGuard)
  // Tenant-wide compliance roll-up is a management report, not self-service.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getCertificationComplianceReport(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<CertificationComplianceReport> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetCertificationComplianceReportQuery(tenantId, departmentId),
    );
  }

  @Query(() => [CertificationType], { name: 'certificationsForWorkArea' })
  async getCertificationsForWorkArea(
    @Args('workAreaId', { type: () => ID }) workAreaId: string,
    @Context() context: GraphQLContext,
  ): Promise<CertificationType[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetCertificationsForWorkAreaQuery(tenantId, workAreaId),
    );
  }

  @Query(() => [MandatoryTrainingStatus], { name: 'mandatoryTrainingStatus' })
  async getMandatoryTrainingStatus(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
  ): Promise<MandatoryTrainingStatus[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetMandatoryTrainingStatusQuery(tenantId, employeeId),
    );
  }

  // =====================
  // Training calendar (scheduled sessions over a date range)
  // =====================
  @Query(() => [TrainingSession], { name: 'trainingCalendar' })
  async getTrainingCalendar(
    @Args('startDate') startDate: string,
    @Args('endDate') endDate: string,
    @Context() context: GraphQLContext,
    @Args('courseId', { type: () => ID, nullable: true }) courseId?: string,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
  ): Promise<TrainingSession[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetTrainingCalendarQuery(tenantId, startDate, endDate, courseId, workAreaId),
    );
  }

  // =====================
  // Certification Type Mutations (tenant configuration — admin/manager)
  // =====================
  @Mutation(() => CertificationType)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_CERTIFICATION_TYPE', resource: 'CertificationType', description: 'Create a certification type' })
  async createCertificationType(
    @Args('input') input: CreateCertificationTypeInput,
    @Context() context: GraphQLContext,
  ): Promise<CertificationType> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<CreateCertificationTypeCommand, CertificationType>(
      new CreateCertificationTypeCommand(tenantId, userId, input),
    );
  }

  @Mutation(() => CertificationType)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_CERTIFICATION_TYPE', resource: 'CertificationType', description: 'Update a certification type' })
  async updateCertificationType(
    @Args('input') input: UpdateCertificationTypeInput,
    @Context() context: GraphQLContext,
  ): Promise<CertificationType> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<UpdateCertificationTypeCommand, CertificationType>(
      new UpdateCertificationTypeCommand(tenantId, userId, input),
    );
  }

  // =====================
  // Training Course Mutations (tenant configuration — admin/manager)
  // =====================
  @Mutation(() => TrainingCourse)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_TRAINING_COURSE', resource: 'TrainingCourse', description: 'Create a training course' })
  async createTrainingCourse(
    @Args('input') input: CreateTrainingCourseInput,
    @Context() context: GraphQLContext,
  ): Promise<TrainingCourse> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<CreateTrainingCourseCommand, TrainingCourse>(
      new CreateTrainingCourseCommand(tenantId, userId, input),
    );
  }

  @Mutation(() => TrainingCourse)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_TRAINING_COURSE', resource: 'TrainingCourse', description: 'Update a training course' })
  async updateTrainingCourse(
    @Args('input') input: UpdateTrainingCourseInput,
    @Context() context: GraphQLContext,
  ): Promise<TrainingCourse> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<UpdateTrainingCourseCommand, TrainingCourse>(
      new UpdateTrainingCourseCommand(tenantId, userId, input),
    );
  }

  // =====================
  // Certification renewal (admin/manager)
  // =====================
  @Mutation(() => EmployeeCertification)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'RENEW_CERTIFICATION', resource: 'EmployeeCertification', description: 'Renew an employee certification' })
  async renewCertification(
    @Args('certificationId', { type: () => ID }) certificationId: string,
    @Args('newExpiryDate') newExpiryDate: string,
    @Context() context: GraphQLContext,
    @Args('certificateNumber', { nullable: true }) certificateNumber?: string,
    @Args('attachmentUrl', { nullable: true }) attachmentUrl?: string,
  ): Promise<EmployeeCertification> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<RenewCertificationCommand, EmployeeCertification>(
      new RenewCertificationCommand(
        tenantId,
        userId,
        certificationId,
        newExpiryDate,
        certificateNumber,
        attachmentUrl,
      ),
    );
  }

  // =====================
  // Training lifecycle — employee self-service
  // =====================
  @Mutation(() => TrainingEnrollment)
  @UseGuards(RolesGuard)
  // Self-service: any authenticated module user may start their OWN enrollment.
  // The owning-employee check is enforced in StartTrainingHandler.
  @ModuleUserOrHigher()
  @AuditLog({ action: 'START_TRAINING', resource: 'TrainingEnrollment', description: 'Start a training enrollment' })
  async startTraining(
    @Args('enrollmentId', { type: () => ID }) enrollmentId: string,
    @Context() context: GraphQLContext,
  ): Promise<TrainingEnrollment> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const callerEmployeeId = await this.resolveEmployeeId(userId, tenantId);
    return this.commandBus.execute<StartTrainingCommand, TrainingEnrollment>(
      new StartTrainingCommand(tenantId, userId, enrollmentId, callerEmployeeId),
    );
  }

  @Mutation(() => TrainingEnrollment)
  @UseGuards(RolesGuard)
  // Self-service: any authenticated module user may withdraw from their OWN
  // enrollment. The owning-employee check is enforced in WithdrawFromTrainingHandler.
  @ModuleUserOrHigher()
  @AuditLog({ action: 'WITHDRAW_FROM_TRAINING', resource: 'TrainingEnrollment', description: 'Withdraw from a training enrollment' })
  async withdrawFromTraining(
    @Args('enrollmentId', { type: () => ID }) enrollmentId: string,
    @Context() context: GraphQLContext,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<TrainingEnrollment> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const callerEmployeeId = await this.resolveEmployeeId(userId, tenantId);
    return this.commandBus.execute<WithdrawFromTrainingCommand, TrainingEnrollment>(
      new WithdrawFromTrainingCommand(tenantId, userId, enrollmentId, callerEmployeeId, reason),
    );
  }

  // =====================
  // Bulk enrollment (admin/manager)
  // =====================
  @Mutation(() => BulkEnrollResult)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'BULK_ENROLL_IN_TRAINING', resource: 'TrainingEnrollment', description: 'Bulk-enroll employees in a training course' })
  async bulkEnrollInTraining(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('employeeIds', { type: () => [ID] }) employeeIds: string[],
    @Context() context: GraphQLContext,
  ): Promise<BulkEnrollResult> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<BulkEnrollInTrainingCommand, BulkEnrollResult>(
      new BulkEnrollInTrainingCommand(tenantId, userId, courseId, employeeIds),
    );
  }
}
