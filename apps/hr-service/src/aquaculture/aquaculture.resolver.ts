import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkArea, WorkAreaType } from './entities/work-area.entity';
import { WorkRotation, RotationStatus } from './entities/work-rotation.entity';
import { SafetyTrainingRecord } from './entities/safety-training-record.entity';
import { Employee } from '../hr/entities/employee.entity';
import {
  GetWorkAreasQuery,
  GetWorkRotationsQuery,
  GetCurrentlyOffshoreQuery,
  GetCrewAssignmentsQuery,
} from './queries';
import { CrewAssignment } from './dto/crew-assignment.dto';

// DTOs
import { CreateWorkAreaInput } from './dto/create-work-area.input';
import { UpdateWorkAreaInput } from './dto/update-work-area.input';
import { CreateWorkRotationInput } from './dto/create-work-rotation.input';
import { UpdateWorkRotationInput } from './dto/update-work-rotation.input';
import { CreateSafetyTrainingRecordInput } from './dto/create-safety-training-record.input';

// Commands
import {
  CreateWorkAreaCommand,
  UpdateWorkAreaCommand,
  DeactivateWorkAreaCommand,
  CreateWorkRotationCommand,
  UpdateWorkRotationCommand,
  StartRotationCommand,
  EndRotationCommand,
  CancelRotationCommand,
  ApproveRotationCommand,
  CreateSafetyTrainingRecordCommand,
  ConfirmSafetyTrainingAttendanceCommand,
} from './commands';

@ObjectType()
class WorkAreaConnection extends StandardPaginatedResponse(WorkArea) {}

@ObjectType()
class WorkRotationConnection extends StandardPaginatedResponse(WorkRotation) {}

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
export class AquacultureResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
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
  // Work Area Queries
  // =====================
  @Query(() => WorkAreaConnection, { name: 'workAreas' })
  async getWorkAreas(
    @Context() context: GraphQLContext,
    @Args('workAreaType', { type: () => WorkAreaType, nullable: true }) workAreaType?: WorkAreaType,
    @Args('isOffshore', { nullable: true }) isOffshore?: boolean,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<WorkArea>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, workAreaType, isOffshore, isActive, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [WorkArea], { name: 'offshoreWorkAreas' })
  async getOffshoreWorkAreas(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Context() context: GraphQLContext,
  ): Promise<WorkArea[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, undefined, true, true, limit, page),
    );
    return result.data;
  }

  // =====================
  // Work Rotation Queries
  // =====================
  @Query(() => WorkRotationConnection, { name: 'workRotations' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getWorkRotations(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<WorkRotation>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, employeeId, workAreaId, status, startDate, endDate, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [WorkRotation], { name: 'myWorkRotations' })
  async getMyWorkRotations(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    // IDOR fix: JWT sub is the auth-service UUID namespace, not the HR employeeId.
    // Passing auth userId directly as employeeId cross-namespaces the lookup —
    // always returns empty (auth UUIDs never match HR UUIDs). Resolve to HR employee.id.
    const employee = await this.employeeRepository.findOne({
      where: { userId, tenantId },
      select: ['id'],
    });
    if (!employee) {
      return [];
    }

    const result = await this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, employee.id, undefined, status, undefined, undefined, limit, page),
    );
    return result.data;
  }

  @Query(() => [Employee], { name: 'currentlyOffshore' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getCurrentlyOffshore(
    @Context() context: GraphQLContext,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetCurrentlyOffshoreQuery(tenantId, workAreaId),
    );
  }

  @Query(() => [WorkRotation], { name: 'activeRotations' })
  async getActiveRotations(
    @Context() context: GraphQLContext,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkRotationsQuery(
        tenantId,
        undefined,
        workAreaId,
        RotationStatus.IN_PROGRESS,
        undefined,
        undefined,
        limit,
        page,
      ),
    );
    return result.data;
  }

  // =====================
  // Crew Assignment Queries
  // =====================
  @Query(() => [CrewAssignment], { name: 'crewAssignments' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getCrewAssignments(
    @Context() context: GraphQLContext,
  ): Promise<CrewAssignment[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetCrewAssignmentsQuery(tenantId));
  }

  // =====================
  // Work Area Mutations
  // =====================

  @Mutation(() => WorkArea)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createWorkArea(
    @Args('input') input: CreateWorkAreaInput,
    @Context() context: GraphQLContext,
  ): Promise<WorkArea> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateWorkAreaCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => WorkArea)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateWorkArea(
    @Args('input') input: UpdateWorkAreaInput,
    @Context() context: GraphQLContext,
  ): Promise<WorkArea> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateWorkAreaCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => WorkArea)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deactivateWorkArea(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<WorkArea> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new DeactivateWorkAreaCommand(tenantId, id, userId),
    );
  }

  // =====================
  // Work Rotation Mutations
  // =====================

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createWorkRotation(
    @Args('input') input: CreateWorkRotationInput,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateWorkRotationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateWorkRotation(
    @Args('input') input: UpdateWorkRotationInput,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateWorkRotationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async startRotation(
    @Args('rotationId', { type: () => ID }) rotationId: string,
    @Args('actualStartDate', { nullable: true }) actualStartDate: string,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new StartRotationCommand(tenantId, rotationId, userId, actualStartDate),
    );
  }

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async endRotation(
    @Args('rotationId', { type: () => ID }) rotationId: string,
    @Args('actualEndDate', { nullable: true }) actualEndDate: string,
    @Args('notes', { nullable: true }) notes: string,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new EndRotationCommand(tenantId, rotationId, userId, actualEndDate, notes),
    );
  }

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cancelRotation(
    @Args('rotationId', { type: () => ID }) rotationId: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CancelRotationCommand(tenantId, rotationId, userId, reason),
    );
  }

  @Mutation(() => WorkRotation)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async approveRotation(
    @Args('rotationId', { type: () => ID }) rotationId: string,
    @Args('notes', { nullable: true }) notes: string,
    @Context() context: GraphQLContext,
  ): Promise<WorkRotation> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ApproveRotationCommand(tenantId, rotationId, userId, notes),
    );
  }

  // =====================
  // Safety Training Mutations
  // =====================

  @Mutation(() => SafetyTrainingRecord)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSafetyTrainingRecord(
    @Args('input') input: CreateSafetyTrainingRecordInput,
    @Context() context: GraphQLContext,
  ): Promise<SafetyTrainingRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateSafetyTrainingRecordCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => SafetyTrainingRecord)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async confirmSafetyTrainingAttendance(
    @Args('recordId', { type: () => ID }) recordId: string,
    @Context() context: GraphQLContext,
  ): Promise<SafetyTrainingRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ConfirmSafetyTrainingAttendanceCommand(tenantId, recordId, userId),
    );
  }
}
