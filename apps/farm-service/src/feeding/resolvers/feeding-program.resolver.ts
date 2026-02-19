/**
 * FeedingProgram GraphQL Resolver
 *
 * Yemleme programi yonetimi icin GraphQL API.
 * Tank bazli yemleme planlama, gunluk calistirma ve yem gecisi islemleri.
 *
 * @module Feeding/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ResolveField,
  Parent,
  ObjectType,
  Field,
  registerEnumType,
} from '@nestjs/graphql';
import {
  UseGuards,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, CurrentUser, Roles, Role, RolesGuard } from '@platform/backend-common';

// DTOs - Import from proper DTO directory
import {
  CreateFeedingProgramInput,
  FeedAssignmentInput,
  FCRTableInput,
  ProgramSettingsInput,
} from '../dto/create-feeding-program.input';
import { UpdateFeedingProgramInput } from '../dto/update-feeding-program.input';
import {
  AddTankToProgramInput,
  RemoveTankFromProgramInput,
} from '../dto/add-tank-to-program.input';
import {
  RecordDailyFeedingInput,
  SkipDailyFeedingInput,
} from '../dto/record-daily-feeding.input';

// Entities
import {
  FeedingProgram,
  FeedingProgramStatus,
  FCRSource,
  FeedAssignment,
  FCRTable,
  ProgramSettings,
} from '../entities/feeding-program.entity';
import {
  FeedingProgramTank,
  ProgramEquipmentType,
} from '../entities/feeding-program-tank.entity';
import {
  DailyFeedingExecution,
  ExecutionStatus,
} from '../entities/daily-feeding-execution.entity';

// Services
import { FeedingProgramService } from '../services/feeding-program.service';
import { DailyFeedingExecutionService } from '../services/daily-feeding-execution.service';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// ============================================================================
// FILTER INPUT TYPES (not exported from dto/, so define here)
// ============================================================================

import { InputType } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsUUID,
} from 'class-validator';

@InputType()
export class FeedingProgramFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => FeedingProgramStatus, { nullable: true })
  @IsOptional()
  @IsEnum(FeedingProgramStatus)
  status?: FeedingProgramStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class FeedingProgramConnection {
  @Field(() => [FeedingProgram])
  items: FeedingProgram[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class DailyFeedingExecutionConnection {
  @Field(() => [DailyFeedingExecution])
  items: DailyFeedingExecution[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

// ============================================================================
// AUDIT LOGGING HELPER
// ============================================================================

/**
 * Audit log entry for sensitive operations
 */
interface AuditLogEntry {
  action: string;
  resourceType: string;
  resourceId: string;
  userId: string;
  tenantId: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard, RolesGuard)
@Resolver(() => FeedingProgram)
export class FeedingProgramResolver {
  private readonly logger = new Logger(FeedingProgramResolver.name);

  constructor(
    @InjectRepository(FeedingProgram)
    private readonly feedingProgramRepository: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly feedingProgramTankRepository: Repository<FeedingProgramTank>,
    @InjectRepository(DailyFeedingExecution)
    private readonly dailyFeedingExecutionRepository: Repository<DailyFeedingExecution>,
    private readonly feedingProgramService: FeedingProgramService,
    private readonly dailyFeedingExecutionService: DailyFeedingExecutionService,
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // FIELD RESOLVERS (to prevent N+1 queries)
  // ==========================================================================

  /**
   * Resolve tanks field with DataLoader pattern
   */
  @ResolveField(() => [FeedingProgramTank], { description: 'Programa bagli tanklar' })
  async tanks(
    @Parent() program: FeedingProgram,
    @Tenant() tenantId: string,
  ): Promise<FeedingProgramTank[]> {
    try {
      // Check if already loaded
      if (program.tanks && Array.isArray(program.tanks)) {
        return program.tanks;
      }

      return await this.feedingProgramTankRepository.find({
        where: {
          feedingProgramId: program.id,
          tenantId,
          isActive: true,
        },
        order: { addedAt: 'ASC' },
      });
    } catch (error) {
      this.logger.error(`Error resolving tanks for program ${program.id}`, error);
      return [];
    }
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get feeding program by ID
   */
  @Query(() => FeedingProgram, { nullable: true, description: 'Yemleme programi getir' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async feedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<FeedingProgram | null> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      return await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
      });
    } catch (error) {
      this.handleError('feedingProgram', error);
      return null;
    }
  }

  /**
   * List feeding programs with filters
   */
  @Query(() => [FeedingProgram], { description: 'Yemleme programlarini listele' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async feedingPrograms(
    @Tenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: FeedingProgramFilterInput,
  ): Promise<FeedingProgram[]> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      const queryBuilder = this.feedingProgramRepository
        .createQueryBuilder('program')
        .where('program.tenantId = :tenantId', { tenantId });

      if (filter?.status) {
        queryBuilder.andWhere('program.status = :status', { status: filter.status });
      }

      if (filter?.search) {
        // Sanitize search input
        const sanitizedSearch = filter.search.replace(/[%_]/g, '\\$&');
        queryBuilder.andWhere(
          '(program.name ILIKE :search OR program.code ILIKE :search)',
          { search: `%${sanitizedSearch}%` },
        );
      }

      // siteId filtering: Filter by tanks belonging to that site
      if (filter?.siteId) {
        queryBuilder
          .innerJoin('program.tanks', 'pt', 'pt.isActive = true')
          .innerJoin('equipment', 'eq', 'eq.id = pt.equipmentId')
          .andWhere('eq.siteId = :siteId', { siteId: filter.siteId });
      }

      queryBuilder.orderBy('program.createdAt', 'DESC');

      return await queryBuilder.getMany();
    } catch (error) {
      this.handleError('feedingPrograms', error);
      return [];
    }
  }

  /**
   * Get active feeding programs
   */
  @Query(() => [FeedingProgram], { description: 'Aktif yemleme programlarini getir' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async activeFeedingPrograms(
    @Tenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
  ): Promise<FeedingProgram[]> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      const queryBuilder = this.feedingProgramRepository
        .createQueryBuilder('program')
        .where('program.tenantId = :tenantId', { tenantId })
        .andWhere('program.status = :status', { status: FeedingProgramStatus.ACTIVE });

      // Filter by site if provided
      if (siteId) {
        queryBuilder
          .innerJoin('program.tanks', 'pt', 'pt.isActive = true')
          .innerJoin('equipment', 'eq', 'eq.id = pt.equipmentId')
          .andWhere('eq.siteId = :siteId', { siteId });
      }

      queryBuilder.orderBy('program.name', 'ASC');

      return await queryBuilder.getMany();
    } catch (error) {
      this.handleError('activeFeedingPrograms', error);
      return [];
    }
  }

  /**
   * Get daily feeding execution by ID
   */
  @Query(() => DailyFeedingExecution, { nullable: true, description: 'Gunluk yemleme calistirmasi getir' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async dailyFeedingExecution(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DailyFeedingExecution | null> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      return await this.dailyFeedingExecutionService.getExecutionById(id, tenantId);
    } catch (error) {
      this.handleError('dailyFeedingExecution', error);
      return null;
    }
  }

  /**
   * List daily feeding executions for a date
   */
  @Query(() => [DailyFeedingExecution], { description: 'Belirli tarihteki gunluk yemleme calistirmalarini listele' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async dailyFeedingExecutions(
    @Tenant() tenantId: string,
    @Args('date') date: Date,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
  ): Promise<DailyFeedingExecution[]> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      const queryBuilder = this.dailyFeedingExecutionRepository
        .createQueryBuilder('execution')
        .leftJoinAndSelect('execution.feedingProgram', 'program')
        .leftJoinAndSelect('execution.feedingProgramTank', 'tank')
        .where('execution.tenantId = :tenantId', { tenantId })
        .andWhere('execution.executionDate = :date', { date });

      // Filter by equipment site if siteId provided
      if (siteId) {
        queryBuilder
          .innerJoin('equipment', 'eq', 'eq.id = execution.equipmentId')
          .andWhere('eq.siteId = :siteId', { siteId });
      }

      queryBuilder.orderBy('execution.equipmentCode', 'ASC');

      return await queryBuilder.getMany();
    } catch (error) {
      this.handleError('dailyFeedingExecutions', error);
      return [];
    }
  }

  /**
   * Get today's feeding plan for a program
   */
  @Query(() => [DailyFeedingExecution], { description: 'Program icin bugunun yemleme planini getir' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async todaysFeedingPlan(
    @Args('programId', { type: () => ID }) programId: string,
    @Tenant() tenantId: string,
  ): Promise<DailyFeedingExecution[]> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return await this.dailyFeedingExecutionService.getExecutionsForDate(
        programId,
        today,
        tenantId,
      );
    } catch (error) {
      this.handleError('todaysFeedingPlan', error);
      return [];
    }
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yeni yemleme programi olustur' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFeedingProgram(
    @Args('input') input: CreateFeedingProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'createFeedingProgram');

    try {
      // Use service layer for complex operations
      const program = await this.feedingProgramService.createProgram(
        {
          name: input.name,
          code: input.code,
          description: input.description,
          feedAssignments: this.mapFeedAssignments(input.feedAssignments),
          fcrTable: input.fcrTable ? this.mapFCRTable(input.fcrTable) : undefined,
          startDate: new Date(input.startDate),
          endDate: input.endDate ? new Date(input.endDate) : undefined,
          settings: input.settings ? {
            autoTransition: input.settings.autoTransition,
            transitionBuffer: input.settings.transitionBuffer,
            notifyOnTransition: input.settings.notifyOnTransition,
            fcrSource: input.settings.fcrSource,
            defaultMealsPerDay: input.settings.defaultMealsPerDay,
            minFeedingRatePercent: input.settings.minFeedingRatePercent,
            maxFeedingRatePercent: input.settings.maxFeedingRatePercent,
          } : undefined,
        },
        user.sub,
        tenantId,
      );

      this.auditLog({
        action: 'CREATE',
        resourceType: 'FeedingProgram',
        resourceId: program.id,
        userId: user.sub,
        tenantId,
        details: { code: input.code, name: input.name },
      });

      return program;
    } catch (error) {
      throw this.handleMutationError('createFeedingProgram', error);
    }
  }

  /**
   * Update a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini guncelle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedingProgram(
    @Args('input') input: UpdateFeedingProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'updateFeedingProgram');

    try {
      // Verify program belongs to tenant
      const existing = await this.feedingProgramRepository.findOne({
        where: { id: input.id, tenantId },
      });

      if (!existing) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const program = await this.feedingProgramService.updateProgram(
        input.id,
        {
          name: input.name,
          description: input.description,
          feedAssignments: input.feedAssignments
            ? this.mapFeedAssignments(input.feedAssignments)
            : undefined,
          fcrTable: input.fcrTable ? this.mapFCRTable(input.fcrTable) : undefined,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
          settings: input.settings ? {
            autoTransition: input.settings.autoTransition,
            transitionBuffer: input.settings.transitionBuffer,
            notifyOnTransition: input.settings.notifyOnTransition,
            fcrSource: input.settings.fcrSource,
            defaultMealsPerDay: input.settings.defaultMealsPerDay,
            minFeedingRatePercent: input.settings.minFeedingRatePercent,
            maxFeedingRatePercent: input.settings.maxFeedingRatePercent,
          } : undefined,
        },
        user.sub,
        tenantId,
      );

      this.auditLog({
        action: 'UPDATE',
        resourceType: 'FeedingProgram',
        resourceId: input.id,
        userId: user.sub,
        tenantId,
      });

      return program;
    } catch (error) {
      throw this.handleMutationError('updateFeedingProgram', error);
    }
  }

  /**
   * Delete a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini sil' })
  @Roles(Role.TENANT_ADMIN)
  async deleteFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'deleteFeedingProgram');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (program.status === FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError('Cannot delete an active program. Please pause or cancel it first.', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      // Use service layer
      await this.feedingProgramService.deleteProgram(id, tenantId);

      this.auditLog({
        action: 'DELETE',
        resourceType: 'FeedingProgram',
        resourceId: id,
        userId: user.sub,
        tenantId,
        details: { code: program.code, name: program.name },
      });

      return program;
    } catch (error) {
      throw this.handleMutationError('deleteFeedingProgram', error);
    }
  }

  /**
   * Activate a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini aktif et' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async activateFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'activateFeedingProgram');

    try {
      // Verify program belongs to tenant
      const existing = await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
        relations: ['tanks'],
      });

      if (!existing) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const activeTanks = existing.tanks?.filter(t => t.isActiveInProgram()) || [];
      if (activeTanks.length === 0) {
        throw new GraphQLError('Cannot activate a program without any tanks assigned', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      // Use service layer
      const program = await this.feedingProgramService.activateProgram(id, tenantId);

      this.auditLog({
        action: 'ACTIVATE',
        resourceType: 'FeedingProgram',
        resourceId: id,
        userId: user.sub,
        tenantId,
      });

      return program;
    } catch (error) {
      throw this.handleMutationError('activateFeedingProgram', error);
    }
  }

  /**
   * Pause a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini duraklat' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async pauseFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'pauseFeedingProgram');

    try {
      // Verify program belongs to tenant
      const existing = await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
      });

      if (!existing) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const program = await this.feedingProgramService.pauseProgram(id, tenantId);

      this.auditLog({
        action: 'PAUSE',
        resourceType: 'FeedingProgram',
        resourceId: id,
        userId: user.sub,
        tenantId,
      });

      return program;
    } catch (error) {
      throw this.handleMutationError('pauseFeedingProgram', error);
    }
  }

  /**
   * Add a tank to a feeding program
   */
  @Mutation(() => FeedingProgramTank, { description: 'Programa tank ekle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addTankToProgram(
    @Args('input') input: AddTankToProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'addTankToProgram');

    try {
      // Verify program belongs to tenant
      const program = await this.feedingProgramRepository.findOne({
        where: { id: input.feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const programTank = await this.feedingProgramService.addTankToProgram(
        input.feedingProgramId,
        input.equipmentId,
        tenantId,
        input.temperatureSensorId,
      );

      this.auditLog({
        action: 'ADD_TANK',
        resourceType: 'FeedingProgram',
        resourceId: input.feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { equipmentId: input.equipmentId },
      });

      return programTank;
    } catch (error) {
      throw this.handleMutationError('addTankToProgram', error);
    }
  }

  /**
   * Remove a tank from a feeding program
   */
  @Mutation(() => FeedingProgramTank, { description: 'Programdan tank cikar' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeTankFromProgram(
    @Args('input') input: RemoveTankFromProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'removeTankFromProgram');

    try {
      const programTank = await this.feedingProgramTankRepository.findOne({
        where: {
          feedingProgramId: input.feedingProgramId,
          equipmentId: input.equipmentId,
          tenantId,
        },
      });

      if (!programTank) {
        throw new GraphQLError('Tank not found in this program', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (!programTank.isActiveInProgram()) {
        throw new GraphQLError('Tank is already removed from this program', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      // Use service layer
      await this.feedingProgramService.removeTankFromProgram(
        input.feedingProgramId,
        input.equipmentId,
        tenantId,
      );

      // Return the updated tank with tenant isolation
      const updatedTank = await this.feedingProgramTankRepository.findOne({
        where: { id: programTank.id, tenantId },
      });

      this.auditLog({
        action: 'REMOVE_TANK',
        resourceType: 'FeedingProgram',
        resourceId: input.feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { equipmentId: input.equipmentId },
      });

      return updatedTank || programTank;
    } catch (error) {
      throw this.handleMutationError('removeTankFromProgram', error);
    }
  }

  /**
   * Generate daily feeding plan for a program
   */
  @Mutation(() => [DailyFeedingExecution], { description: 'Gunluk yemleme plani olustur' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async generateDailyPlan(
    @Args('programId', { type: () => ID }) programId: string,
    @Args('date') date: Date,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DailyFeedingExecution[]> {
    this.validateTenantAndUser(tenantId, user, 'generateDailyPlan');

    try {
      // Verify program belongs to tenant
      const program = await this.feedingProgramRepository.findOne({
        where: { id: programId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const result = await this.dailyFeedingExecutionService.generateDailyPlan(
        programId,
        date,
        tenantId,
      );

      this.auditLog({
        action: 'GENERATE_DAILY_PLAN',
        resourceType: 'FeedingProgram',
        resourceId: programId,
        userId: user.sub,
        tenantId,
        details: { date: date.toISOString(), executionsCreated: result.executionsCreated },
      });

      return result.executions;
    } catch (error) {
      throw this.handleMutationError('generateDailyPlan', error);
    }
  }

  /**
   * Record actual daily feeding
   */
  @Mutation(() => DailyFeedingExecution, { description: 'Gunluk yemleme kaydet' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async recordDailyFeeding(
    @Args('input') input: RecordDailyFeedingInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DailyFeedingExecution> {
    // CRITICAL: tenantId and user are required, not optional
    this.validateTenantAndUser(tenantId, user, 'recordDailyFeeding');

    if (input.actualKg < 0) {
      throw new GraphQLError('Actual feed amount cannot be negative', {
        extensions: { code: 'BAD_REQUEST' },
      });
    }

    try {
      // Verify execution belongs to tenant
      const execution = await this.dailyFeedingExecutionRepository.findOne({
        where: { id: input.executionId, tenantId },
        relations: ['feedingProgram', 'feedingProgramTank'],
      });

      if (!execution) {
        throw new GraphQLError('Daily feeding execution not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const result = await this.dailyFeedingExecutionService.recordActualFeeding(
        input.executionId,
        input.actualKg,
        user.sub,
        tenantId,
        input.notes,
      );

      // Save feeder info if provided
      if (input.feedingMethod || input.feederEquipmentId) {
        const feederUpdate: Record<string, unknown> = {};
        if (input.feedingMethod) {
          feederUpdate.feedingMethod = input.feedingMethod;
        }
        if (input.feederEquipmentId) {
          feederUpdate.feederEquipmentId = input.feederEquipmentId;
          // Lookup feeder name from SubEquipment for denormalization
          try {
            const subEquipmentRepo = this.dataSource.getRepository('SubEquipment');
            const feeder = await subEquipmentRepo.findOne({
              where: { id: input.feederEquipmentId, tenantId },
              select: ['id', 'name'],
            });
            if (feeder) {
              feederUpdate.feederName = (feeder as { name: string }).name;
            }
          } catch {
            // SubEquipment lookup failed - continue without feederName
          }
        }
        // SECURITY: Include tenantId in WHERE clause to prevent cross-tenant writes
        await this.dailyFeedingExecutionRepository.update(
          { id: input.executionId, tenantId },
          feederUpdate,
        );
      }

      // Fetch updated execution with tenant isolation
      const updatedExecution = await this.dailyFeedingExecutionRepository.findOne({
        where: { id: input.executionId, tenantId },
        relations: ['feedingProgram', 'feedingProgramTank'],
      });

      // Note: totalFeedTransitions is already incremented inside recordActualFeeding()
      // Do NOT double-increment here via safeProgramIncrement

      this.auditLog({
        action: 'RECORD_FEEDING',
        resourceType: 'DailyFeedingExecution',
        resourceId: input.executionId,
        userId: user.sub,
        tenantId,
        details: {
          actualKg: input.actualKg,
          growthKg: result.growthKg,
          feedTransitioned: result.feedTransitioned,
          feedingMethod: input.feedingMethod,
          feederEquipmentId: input.feederEquipmentId,
        },
      });

      return updatedExecution || execution;
    } catch (error) {
      throw this.handleMutationError('recordDailyFeeding', error);
    }
  }

  /**
   * Skip daily feeding
   */
  @Mutation(() => DailyFeedingExecution, { description: 'Gunluk yemlemeyi atla' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async skipDailyFeeding(
    @Args('input') input: SkipDailyFeedingInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DailyFeedingExecution> {
    this.validateTenantAndUser(tenantId, user, 'skipDailyFeeding');

    if (!input.skipReason || input.skipReason.trim().length === 0) {
      throw new GraphQLError('Skip reason is required', {
        extensions: { code: 'BAD_REQUEST' },
      });
    }

    try {
      // Verify execution belongs to tenant
      const execution = await this.dailyFeedingExecutionRepository.findOne({
        where: { id: input.executionId, tenantId },
      });

      if (!execution) {
        throw new GraphQLError('Daily feeding execution not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Use service layer
      const updated = await this.dailyFeedingExecutionService.skipDailyFeeding(
        input.executionId,
        input.skipReason,
        user.sub,
        tenantId,
      );

      this.auditLog({
        action: 'SKIP_FEEDING',
        resourceType: 'DailyFeedingExecution',
        resourceId: input.executionId,
        userId: user.sub,
        tenantId,
        details: { reason: input.skipReason },
      });

      return updated;
    } catch (error) {
      throw this.handleMutationError('skipDailyFeeding', error);
    }
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  /**
   * Validate tenant and user context
   */
  private validateTenantAndUser(
    tenantId: string | undefined,
    user: UserContext | undefined,
    operation: string,
  ): void {
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    if (!user) {
      throw new UnauthorizedException('User context required');
    }
    this.logger.debug(`${operation}: user=${user.sub}, tenant=${tenantId}`);
  }

  /**
   * Safely increment program statistics with tenant validation
   */
  private async safeProgramIncrement(
    programId: string,
    tenantId: string,
    field: 'totalFeedTransitions' | 'totalTanks',
  ): Promise<void> {
    try {
      await this.feedingProgramRepository.increment(
        { id: programId, tenantId }, // Include tenantId in where clause
        field,
        1,
      );
    } catch (error) {
      this.logger.error(`Failed to increment ${field} for program ${programId}`, error);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Handle query errors (return empty result, log error)
   */
  private handleError(operation: string, error: unknown): void {
    if (error instanceof UnauthorizedException) {
      throw error;
    }
    if (error instanceof GraphQLError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    this.logger.error(`Error in ${operation}: ${message}`, error);
  }

  /**
   * Handle mutation errors (throw GraphQL error with sanitized message)
   */
  private handleMutationError(operation: string, error: unknown): GraphQLError {
    if (error instanceof GraphQLError) {
      return error;
    }
    if (error instanceof UnauthorizedException) {
      return new GraphQLError(error.message, {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    this.logger.error(`Error in ${operation}: ${message}`, error);

    // Sanitize error messages to not expose internal details
    const sanitizedMessage = this.sanitizeErrorMessage(message);

    return new GraphQLError(sanitizedMessage, {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  }

  /**
   * Sanitize error message to not expose internal details
   */
  private sanitizeErrorMessage(message: string): string {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /database/i,
      /sql/i,
      /connection/i,
      /query failed/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(message)) {
        return 'An error occurred while processing your request';
      }
    }

    return message;
  }

  /**
   * Audit log for sensitive operations
   */
  private auditLog(entry: AuditLogEntry): void {
    this.logger.log(
      `AUDIT: ${entry.action} ${entry.resourceType} ${entry.resourceId} ` +
      `by user ${entry.userId} in tenant ${entry.tenantId}` +
      (entry.details ? ` - ${JSON.stringify(entry.details)}` : ''),
    );
  }

  /**
   * Map FeedAssignmentInput to FeedAssignment entity format
   */
  private mapFeedAssignments(inputs: FeedAssignmentInput[]): FeedAssignment[] {
    return inputs.map((input, index) => ({
      feedId: input.feedId,
      feedCode: '', // Will be populated by service
      feedName: '', // Will be populated by service
      minWeightG: input.minWeightG,
      maxWeightG: input.maxWeightG,
      priority: input.priority ?? index + 1,
      notes: input.notes,
    }));
  }

  /**
   * Map FCRTableInput to FCRTable entity format
   */
  private mapFCRTable(input: FCRTableInput): FCRTable {
    return {
      temperatures: input.temperatures,
      weights: input.weights,
      fcrValues: input.fcrValues,
      temperatureUnit: input.temperatureUnit,
      weightUnit: input.weightUnit,
      notes: input.notes,
    };
  }
}

// ============================================================================
// DAILY FEEDING EXECUTION RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard, RolesGuard)
@Resolver(() => DailyFeedingExecution)
export class DailyFeedingExecutionResolver {
  constructor(
    @InjectRepository(FeedingProgram)
    private readonly feedingProgramRepository: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly feedingProgramTankRepository: Repository<FeedingProgramTank>,
  ) {}

  /**
   * Resolve feedingProgram field
   */
  @ResolveField(() => FeedingProgram, { nullable: true })
  async feedingProgram(
    @Parent() execution: DailyFeedingExecution,
    @Tenant() tenantId: string,
  ): Promise<FeedingProgram | null> {
    if (execution.feedingProgram) {
      return execution.feedingProgram;
    }
    if (!execution.feedingProgramId) {
      return null;
    }

    return this.feedingProgramRepository.findOne({
      where: { id: execution.feedingProgramId, tenantId },
    });
  }

  /**
   * Resolve feedingProgramTank field
   */
  @ResolveField(() => FeedingProgramTank, { nullable: true })
  async feedingProgramTank(
    @Parent() execution: DailyFeedingExecution,
    @Tenant() tenantId: string,
  ): Promise<FeedingProgramTank | null> {
    if (execution.feedingProgramTank) {
      return execution.feedingProgramTank;
    }
    if (!execution.feedingProgramTankId) {
      return null;
    }

    return this.feedingProgramTankRepository.findOne({
      where: { id: execution.feedingProgramTankId, tenantId },
    });
  }
}

// ============================================================================
// FEEDING PROGRAM TANK RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard, RolesGuard)
@Resolver(() => FeedingProgramTank)
export class FeedingProgramTankResolver {
  constructor(
    @InjectRepository(FeedingProgram)
    private readonly feedingProgramRepository: Repository<FeedingProgram>,
  ) {}

  /**
   * Resolve feedingProgram field
   */
  @ResolveField(() => FeedingProgram, { nullable: true })
  async feedingProgram(
    @Parent() tank: FeedingProgramTank,
    @Tenant() tenantId: string,
  ): Promise<FeedingProgram | null> {
    if (tank.feedingProgram) {
      return tank.feedingProgram;
    }
    if (!tank.feedingProgramId) {
      return null;
    }

    return this.feedingProgramRepository.findOne({
      where: { id: tank.feedingProgramId, tenantId },
    });
  }
}
