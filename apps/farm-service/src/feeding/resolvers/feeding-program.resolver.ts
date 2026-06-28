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
import GraphQLJSON from 'graphql-type-json';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, CurrentUser, Roles, Role, RequiresMobileFeature } from '@aquaculture/backend-common/decorators';
import { RolesGuard, MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
import { TenantContextError, TenantScopedRepository } from '@aquaculture/backend-common/database';
import { Feed } from '../../feed/entities/feed.entity';
import { SubEquipment } from '../../equipment/entities/sub-equipment.entity';

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
  GenerateDailyPlanInput,
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
import { RestoreService } from '../../common/services/restore.service';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  // SEC-HIGH-051: roles as the canonical Role[] so the site-authz threading
  // below carries the SSoT vocabulary (the JWT guard validates enum membership).
  roles: Role[];
  // SEC-HIGH-051: the caller's assigned farm Site ids (object-level site authz).
  assignedSiteIds?: string[];
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
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsArray,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  @Field({ nullable: true })
  @IsOptional()
  startDateFrom?: Date;

  @Field({ nullable: true })
  @IsOptional()
  startDateTo?: Date;

  @Field({ nullable: true })
  @IsOptional()
  includeInactive?: boolean;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class FeedingProgramConnection extends StandardPaginatedResponse(FeedingProgram) {}

@ObjectType()
export class DailyFeedingExecutionConnection extends StandardPaginatedResponse(DailyFeedingExecution) {}

// ============================================================================
// INPUT TYPES FOR MISSING MUTATIONS
// ============================================================================

/**
 * Input for adding a single tank in bulk operation
 */
@InputType()
export class AddTankInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  equipmentId: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  temperatureSensorCode?: string;
}

/**
 * Input for recalculating daily plan parameters
 */
@InputType()
export class RecalculateParametersInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  avgWeightG?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fishCount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  biomassKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  waterTempC?: number;
}

// ============================================================================
// RESPONSE TYPES FOR MISSING MUTATIONS
// ============================================================================

/**
 * Failed bulk feeding entry
 */
@ObjectType()
export class BulkFeedingFailure {
  @Field(() => ID)
  executionId: string;

  @Field()
  error: string;
}

/**
 * Result of bulk feeding recording
 */
@ObjectType()
export class BulkFeedingResult {
  @Field(() => [DailyFeedingExecution])
  successful: DailyFeedingExecution[];

  @Field(() => [BulkFeedingFailure])
  failed: BulkFeedingFailure[];

  @Field(() => Int)
  totalSuccessful: number;

  @Field(() => Int)
  totalFailed: number;
}

/**
 * Extended execution result with recalculation info
 */
@ObjectType()
export class RecalculatedExecution {
  @Field(() => DailyFeedingExecution)
  execution: DailyFeedingExecution;

  @Field(() => GraphQLJSON, { nullable: true })
  previousCalculations?: Record<string, unknown>;

  @Field({ nullable: true })
  changeReason?: string;
}

@ObjectType()
export class GenerateDailyPlanResult {
  @Field()
  date: Date;

  @Field(() => Int)
  generatedCount: number;

  @Field(() => [DailyFeedingExecution])
  executions: DailyFeedingExecution[];

  @Field(() => [String], { nullable: true })
  warnings?: string[];
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

// SEC-HIGH-052: MobileFeatureGuard enforces the 'feeding' entitlement on every
// feeding-write mutation — recordDailyFeeding, recordBulkFeeding, skipDailyFeeding
// (no-op on the un-annotated config/read mutations).
@UseGuards(GqlAuthGuard, RolesGuard, MobileFeatureGuard)
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
    private readonly restoreService: RestoreService,
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
      // A lost/wrong tenant context must NOT be masked as "no tanks".
      if (error instanceof TenantContextError) {
        throw error;
      }
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
    @Args('filter', { type: () => FeedingProgramFilterInput, nullable: true }) filter?: FeedingProgramFilterInput,
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

      if (filter?.startDateFrom) {
        queryBuilder.andWhere('program.startDate >= :startDateFrom', { startDateFrom: filter.startDateFrom });
      }

      if (filter?.startDateTo) {
        queryBuilder.andWhere('program.startDate <= :startDateTo', { startDateTo: filter.startDateTo });
      }

      if (filter?.includeInactive === false) {
        queryBuilder.andWhere('program.status != :inactiveStatus', { inactiveStatus: 'INACTIVE' });
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
   * Supports both signatures:
   *   - updateFeedingProgram(input: { id, ... })           -- backend-native
   *   - updateFeedingProgram(id: ID!, input: { ... })      -- frontend sends id separately
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini guncelle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedingProgram(
    @Args('input') input: UpdateFeedingProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('id', { type: () => ID, nullable: true }) id?: string,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'updateFeedingProgram');

    // If id is provided as a separate argument, merge it into the input
    if (id) {
      input.id = id;
    }

    if (!input.id) {
      throw new GraphQLError('Program ID is required (either in input.id or as a separate id argument)', {
        extensions: { code: 'BAD_REQUEST' },
      });
    }

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
   * Restore a soft-deleted feeding program. TENANT_ADMIN only —
   * restores the program row but does NOT auto-resume the schedule;
   * the operator must explicitly activateFeedingProgram afterwards.
   * Uniqueness is checked on (tenantId, code) per
   * feeding-program.entity.ts:451 so a code reused since the soft
   * delete surfaces RestoreUniquenessConflictError.
   *
   * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan.
   */
  @Mutation(() => FeedingProgram, { description: 'Soft-silinmis yemleme programini geri al' })
  @Roles(Role.TENANT_ADMIN)
  async restoreFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'restoreFeedingProgram');
    this.logger.log(`Restoring feeding program ${id} for tenant ${tenantId} by user ${user.sub}`);
    return this.restoreService.restore<FeedingProgram>(
      this.feedingProgramRepository,
      FeedingProgram,
      id,
      { tenantId, userId: user.sub },
      {
        uniqueKeys: [['code']],
      },
    );
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
   * Frontend sends optional reason parameter for audit logging
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini duraklat' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async pauseFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
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
        details: reason ? { reason } : undefined,
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
   * Supports both signatures:
   *   - removeTankFromProgram(input: { feedingProgramId, equipmentId })  -- backend-native
   *   - removeTankFromProgram(feedingProgramTankId: ID!, reason: String) -- frontend sends tank record ID
   */
  @Mutation(() => FeedingProgramTank, { description: 'Programdan tank cikar' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeTankFromProgram(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input', { type: () => RemoveTankFromProgramInput, nullable: true }) input?: RemoveTankFromProgramInput,
    @Args('feedingProgramTankId', { type: () => ID, nullable: true }) feedingProgramTankId?: string,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'removeTankFromProgram');

    try {
      let programTank: FeedingProgramTank | null = null;

      if (feedingProgramTankId) {
        // Frontend pattern: lookup by the junction record ID directly
        programTank = await this.feedingProgramTankRepository.findOne({
          where: { id: feedingProgramTankId, tenantId },
        });
      } else if (input) {
        // Backend-native pattern: lookup by feedingProgramId + equipmentId
        programTank = await this.feedingProgramTankRepository.findOne({
          where: {
            feedingProgramId: input.feedingProgramId,
            equipmentId: input.equipmentId,
            tenantId,
          },
        });
      } else {
        throw new GraphQLError('Either feedingProgramTankId or input must be provided', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

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
        programTank.feedingProgramId,
        programTank.equipmentId,
        tenantId,
      );

      // Return the updated tank with tenant isolation
      const updatedTank = await this.feedingProgramTankRepository.findOne({
        where: { id: programTank.id, tenantId },
      });

      this.auditLog({
        action: 'REMOVE_TANK',
        resourceType: 'FeedingProgram',
        resourceId: programTank.feedingProgramId,
        userId: user.sub,
        tenantId,
        details: {
          equipmentId: programTank.equipmentId,
          feedingProgramTankId: programTank.id,
          ...(reason ? { reason } : {}),
        },
      });

      return updatedTank || programTank;
    } catch (error) {
      throw this.handleMutationError('removeTankFromProgram', error);
    }
  }

  /**
   * Generate daily feeding plan for a program
   * Supports both signatures:
   *   - generateDailyPlan(programId: ID!, date: Date!)          -- backend-native
   *   - generateDailyPlan(input: GenerateDailyPlanInput!)       -- frontend sends single input object
   */
  @Mutation(() => GenerateDailyPlanResult, { description: 'Gunluk yemleme plani olustur' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async generateDailyPlan(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input', { type: () => GenerateDailyPlanInput, nullable: true }) input?: GenerateDailyPlanInput,
    @Args('programId', { type: () => ID, nullable: true }) programIdArg?: string,
    @Args('date', { type: () => Date, nullable: true }) dateArg?: Date,
  ): Promise<GenerateDailyPlanResult> {
    this.validateTenantAndUser(tenantId, user, 'generateDailyPlan');

    // Resolve parameters from either input object or separate args
    const programId = input?.programId ?? programIdArg;
    const date = input?.date ?? dateArg;

    if (!programId || !date) {
      throw new GraphQLError('programId and date are required (either via input object or as separate arguments)', {
        extensions: { code: 'BAD_REQUEST' },
      });
    }

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
        date instanceof Date ? date : new Date(date),
        tenantId,
      );

      this.auditLog({
        action: 'GENERATE_DAILY_PLAN',
        resourceType: 'FeedingProgram',
        resourceId: programId,
        userId: user.sub,
        tenantId,
        details: {
          date: date instanceof Date ? date.toISOString() : date,
          executionsCreated: result.executionsCreated,
        },
      });

      return {
        date: result.date,
        generatedCount: result.executionsCreated,
        executions: result.executions,
        warnings: result.errors.length > 0 ? result.errors : undefined,
      };
    } catch (error) {
      throw this.handleMutationError('generateDailyPlan', error);
    }
  }

  /**
   * Record actual daily feeding
   */
  @Mutation(() => DailyFeedingExecution, { description: 'Gunluk yemleme kaydet' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('feeding')
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

      // SEC-HIGH-051: object-level site authorization is enforced AT THE SINK
      // (DailyFeedingExecutionService.recordActualFeeding) — the ONE SSoT shared
      // by recordDailyFeeding, recordBulkFeeding, and any future caller. The
      // caller (sub/roles/assignedSiteIds) is threaded into the sink, which
      // resolves the execution's tank site on its own transactional manager and
      // asserts fail-closed before the write. No duplicated resolver-level check.
      // FARM-MEDIUM-051: pass the mobile command envelope so the durable receipt
      // is keyed on the client command id — a retry of a committed feeding
      // replays as an idempotent no-op success instead of a hard failure.
      const result = await this.dailyFeedingExecutionService.recordActualFeeding(
        input.executionId,
        input.actualKg,
        user.sub,
        tenantId,
        { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
        input.notes,
        mobileCommandEnvelopeFromInput(input),
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
            // tenantId auto-injected by TenantScopedRepository.create; the
            // entity class gives us full type safety vs. the prior string
            // lookup which returned Repository<ObjectLiteral>.
            const subEquipmentRepo = TenantScopedRepository.create(
              this.dataSource,
              SubEquipment,
              tenantId,
            );
            const feeder = await subEquipmentRepo.findOne({
              where: { id: input.feederEquipmentId },
              select: ['id', 'name'],
            });
            if (feeder) {
              feederUpdate.feederName = feeder.name;
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
  @RequiresMobileFeature('feeding')
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

      // SEC-HIGH-051: site authorization is enforced AT THE SINK
      // (DailyFeedingExecutionService.skipDailyFeeding) — the caller is asserted
      // against the execution's tank site there, fail-closed.
      const updated = await this.dailyFeedingExecutionService.skipDailyFeeding(
        input.executionId,
        input.skipReason,
        user.sub,
        tenantId,
        { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
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
  // MISSING MUTATIONS (14 mutations called by frontend)
  // ==========================================================================

  /**
   * Complete a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini tamamla' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async completeFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Args('notes', { type: () => String, nullable: true }) notes: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'completeFeedingProgram');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (program.status !== FeedingProgramStatus.ACTIVE && program.status !== FeedingProgramStatus.PAUSED) {
        throw new GraphQLError(
          `Cannot complete program in '${program.status}' status. Only ACTIVE or PAUSED programs can be completed.`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      program.complete();
      program.lastModifiedBy = user.sub;
      if (notes) {
        program.description = program.description
          ? `${program.description}\n\nCompletion notes: ${notes}`
          : `Completion notes: ${notes}`;
      }

      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'COMPLETE',
        resourceType: 'FeedingProgram',
        resourceId: id,
        userId: user.sub,
        tenantId,
        details: { notes },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('completeFeedingProgram', error);
    }
  }

  /**
   * Cancel a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Yemleme programini iptal et' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cancelFeedingProgram(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'cancelFeedingProgram');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (program.status === FeedingProgramStatus.COMPLETED || program.status === FeedingProgramStatus.CANCELLED) {
        throw new GraphQLError(
          `Cannot cancel program in '${program.status}' status.`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        program.cancel();
        program.lastModifiedBy = user.sub;
        await queryRunner.manager.save(program);

        await queryRunner.manager.update(
          FeedingProgramTank,
          { feedingProgramId: id, tenantId, isActive: true },
          { isActive: false, removedAt: new Date() },
        );

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }

      this.auditLog({
        action: 'CANCEL',
        resourceType: 'FeedingProgram',
        resourceId: id,
        userId: user.sub,
        tenantId,
        details: { reason },
      });

      return await this.feedingProgramRepository.findOneOrFail({ where: { id, tenantId } });
    } catch (error) {
      throw this.handleMutationError('cancelFeedingProgram', error);
    }
  }

  /**
   * Add multiple tanks to a program at once
   */
  @Mutation(() => [FeedingProgramTank], { description: 'Programa birden fazla tank ekle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addTanksToProgram(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('tanks', { type: () => [AddTankInput] }) tanks: AddTankInput[],
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank[]> {
    this.validateTenantAndUser(tenantId, user, 'addTanksToProgram');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const results: FeedingProgramTank[] = [];
      for (const tank of tanks) {
        const programTank = await this.feedingProgramService.addTankToProgram(
          feedingProgramId,
          tank.equipmentId,
          tenantId,
          tank.temperatureSensorId,
        );
        results.push(programTank);
      }

      this.auditLog({
        action: 'ADD_TANKS_BULK',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { tankCount: tanks.length },
      });

      return results;
    } catch (error) {
      throw this.handleMutationError('addTanksToProgram', error);
    }
  }

  /**
   * Reactivate a removed tank in a program
   */
  @Mutation(() => FeedingProgramTank, { description: 'Tanki programa tekrar dahil et' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async reactivateTankInProgram(
    @Args('feedingProgramTankId', { type: () => ID }) feedingProgramTankId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'reactivateTankInProgram');

    try {
      const programTank = await this.feedingProgramTankRepository.findOne({
        where: { id: feedingProgramTankId, tenantId },
      });

      if (!programTank) {
        throw new GraphQLError('Program tank not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (programTank.isActiveInProgram()) {
        throw new GraphQLError('Tank is already active in this program', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        programTank.reactivate();
        programTank.lastModifiedBy = user.sub;
        await queryRunner.manager.save(programTank);

        const program = await queryRunner.manager.findOne(FeedingProgram, {
          where: { id: programTank.feedingProgramId, tenantId },
        });
        if (program) {
          const tankCount = await queryRunner.manager.count(FeedingProgramTank, {
            where: { feedingProgramId: programTank.feedingProgramId, isActive: true },
          });
          program.totalTanks = tankCount;
          await queryRunner.manager.save(program);
        }

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }

      this.auditLog({
        action: 'REACTIVATE_TANK',
        resourceType: 'FeedingProgramTank',
        resourceId: feedingProgramTankId,
        userId: user.sub,
        tenantId,
      });

      return await this.feedingProgramTankRepository.findOneOrFail({
        where: { id: feedingProgramTankId, tenantId },
      });
    } catch (error) {
      throw this.handleMutationError('reactivateTankInProgram', error);
    }
  }

  /**
   * Assign a temperature sensor to a program tank
   */
  @Mutation(() => FeedingProgramTank, { description: 'Tanka sicaklik sensoru bagla' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async assignTemperatureSensor(
    @Args('feedingProgramTankId', { type: () => ID }) feedingProgramTankId: string,
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('sensorCode', { type: () => String, nullable: true }) sensorCode: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'assignTemperatureSensor');

    try {
      const programTank = await this.feedingProgramTankRepository.findOne({
        where: { id: feedingProgramTankId, tenantId },
      });

      if (!programTank) {
        throw new GraphQLError('Program tank not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (!programTank.isActiveInProgram()) {
        throw new GraphQLError('Cannot assign sensor to an inactive tank', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      programTank.updateTemperatureSensor(sensorId, sensorCode || null);
      programTank.lastModifiedBy = user.sub;

      const saved = await this.feedingProgramTankRepository.save(programTank);

      this.auditLog({
        action: 'ASSIGN_SENSOR',
        resourceType: 'FeedingProgramTank',
        resourceId: feedingProgramTankId,
        userId: user.sub,
        tenantId,
        details: { sensorId, sensorCode },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('assignTemperatureSensor', error);
    }
  }

  /**
   * Manually transition a tank's feed
   */
  @Mutation(() => FeedingProgramTank, { description: 'Tankin yem gecisini manuel yap' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async transitionTankFeed(
    @Args('feedingProgramTankId', { type: () => ID }) feedingProgramTankId: string,
    @Args('newFeedId', { type: () => ID }) newFeedId: string,
    @Args('newFeedCode') newFeedCode: string,
    @Args('rangeIndex', { type: () => Int }) rangeIndex: number,
    @Args('notes', { type: () => String, nullable: true }) notes: string | undefined,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgramTank> {
    this.validateTenantAndUser(tenantId, user, 'transitionTankFeed');

    try {
      const programTank = await this.feedingProgramTankRepository.findOne({
        where: { id: feedingProgramTankId, tenantId },
      });

      if (!programTank) {
        throw new GraphQLError('Program tank not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (!programTank.isActiveInProgram()) {
        throw new GraphQLError('Cannot transition feed for an inactive tank', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        programTank.transitionToFeed(newFeedId, newFeedCode, rangeIndex);
        programTank.lastModifiedBy = user.sub;
        if (notes) {
          programTank.notes = notes;
        }
        await queryRunner.manager.save(programTank);

        await queryRunner.manager.increment(
          FeedingProgram,
          { id: programTank.feedingProgramId, tenantId },
          'totalFeedTransitions',
          1,
        );

        await queryRunner.commitTransaction();
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }

      this.auditLog({
        action: 'TRANSITION_FEED',
        resourceType: 'FeedingProgramTank',
        resourceId: feedingProgramTankId,
        userId: user.sub,
        tenantId,
        details: { newFeedId, newFeedCode, rangeIndex },
      });

      return await this.feedingProgramTankRepository.findOneOrFail({
        where: { id: feedingProgramTankId, tenantId },
      });
    } catch (error) {
      throw this.handleMutationError('transitionTankFeed', error);
    }
  }

  /**
   * Record bulk feeding for multiple tanks.
   *
   * SEC-HIGH-052: gated by the 'feeding' mobile entitlement (same as the single
   * recordDailyFeeding) — a mobile-disabled user can no longer drive it.
   * SEC-HIGH-051: object-level site authorization is enforced PER-INPUT at the
   * shared sink (recordActualFeeding). A site the caller is not assigned to (or
   * an unresolved site) rejects THAT input into `failed[]` — it never silently
   * writes — while authorized inputs in the same batch still succeed.
   */
  @Mutation(() => BulkFeedingResult, { description: 'Toplu yemleme kaydi' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('feeding')
  async recordBulkFeeding(
    @Args('inputs', { type: () => [RecordDailyFeedingInput] }) inputs: RecordDailyFeedingInput[],
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<BulkFeedingResult> {
    this.validateTenantAndUser(tenantId, user, 'recordBulkFeeding');

    const successful: DailyFeedingExecution[] = [];
    const failed: BulkFeedingFailure[] = [];
    // SEC-HIGH-051: the same site-scope caller is threaded into every per-input
    // sink call so the sink asserts site assignment for each execution.
    const caller = { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds };

    for (const input of inputs) {
      try {
        if (input.actualKg < 0) {
          failed.push({ executionId: input.executionId, error: 'Actual feed amount cannot be negative' });
          continue;
        }

        const execution = await this.dailyFeedingExecutionRepository.findOne({
          where: { id: input.executionId, tenantId },
        });

        if (!execution) {
          failed.push({ executionId: input.executionId, error: 'Daily feeding execution not found' });
          continue;
        }

        await this.dailyFeedingExecutionService.recordActualFeeding(
          input.executionId, input.actualKg, user.sub, tenantId, caller,
          input.notes, mobileCommandEnvelopeFromInput(input),
        );

        const updated = await this.dailyFeedingExecutionRepository.findOne({
          where: { id: input.executionId, tenantId },
        });
        if (updated) {
          successful.push(updated);
        }
      } catch (error) {
        failed.push({
          executionId: input.executionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.auditLog({
      action: 'RECORD_BULK_FEEDING',
      resourceType: 'DailyFeedingExecution',
      resourceId: 'bulk',
      userId: user.sub,
      tenantId,
      details: { totalInputs: inputs.length, successful: successful.length, failed: failed.length },
    });

    return { successful, failed, totalSuccessful: successful.length, totalFailed: failed.length };
  }

  /**
   * Recalculate daily plan for an execution
   */
  @Mutation(() => DailyFeedingExecution, { description: 'Gunluk plani yeniden hesapla' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async recalculateDailyPlan(
    @Args('executionId', { type: () => ID }) executionId: string,
    @Args('newParameters', { type: () => RecalculateParametersInput, nullable: true }) newParameters: RecalculateParametersInput | undefined,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DailyFeedingExecution> {
    this.validateTenantAndUser(tenantId, user, 'recalculateDailyPlan');

    try {
      const execution = await this.dailyFeedingExecutionRepository.findOne({
        where: { id: executionId, tenantId },
        relations: ['feedingProgram', 'feedingProgramTank'],
      });

      if (!execution) {
        throw new GraphQLError('Daily feeding execution not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (execution.status !== ExecutionStatus.PLANNED) {
        throw new GraphQLError(
          `Cannot recalculate execution in '${execution.status}' status. Only PLANNED executions can be recalculated.`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      if (newParameters) {
        if (newParameters.avgWeightG !== undefined) execution.calculations.avgWeightG = newParameters.avgWeightG;
        if (newParameters.fishCount !== undefined) execution.calculations.fishCount = newParameters.fishCount;
        if (newParameters.biomassKg !== undefined) execution.calculations.biomassKg = newParameters.biomassKg;
        if (newParameters.waterTempC !== undefined) execution.calculations.waterTempC = newParameters.waterTempC;

        const biomassKg = execution.calculations.biomassKg;
        const feedingRate = execution.calculations.feedingRatePercent;
        const mealsPerDay = execution.calculations.mealsPerDay;

        execution.calculations.plannedFeedKg = (biomassKg * feedingRate) / 100;
        if (mealsPerDay > 0) {
          execution.calculations.perMealKg = execution.calculations.plannedFeedKg / mealsPerDay;
        }
      }

      execution.lastModifiedBy = user.sub;
      const saved = await this.dailyFeedingExecutionRepository.save(execution);

      this.auditLog({
        action: 'RECALCULATE_PLAN',
        resourceType: 'DailyFeedingExecution',
        resourceId: executionId,
        userId: user.sub,
        tenantId,
        details: { newParameters },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('recalculateDailyPlan', error);
    }
  }

  /**
   * Add a feed assignment to an existing program
   */
  @Mutation(() => FeedingProgram, { description: 'Programa yem atamasi ekle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addFeedAssignment(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('assignment') assignment: FeedAssignmentInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'addFeedAssignment');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', { extensions: { code: 'NOT_FOUND' } });
      }

      if (!program.isEditable() && program.status !== FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError(
          `Cannot modify feed assignments in '${program.status}' status`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      const newAssignment: FeedAssignment = {
        feedId: assignment.feedId,
        feedCode: '',
        feedName: '',
        minWeightG: assignment.minWeightG,
        maxWeightG: assignment.maxWeightG,
        priority: assignment.priority ?? program.feedAssignments.length + 1,
        notes: assignment.notes,
      };

      try {
        const feedRepo = TenantScopedRepository.create(this.dataSource, Feed, tenantId);
        const feed = await feedRepo.findOne({ where: { id: assignment.feedId }, select: ['id', 'code', 'name'] });
        if (feed) {
          newAssignment.feedCode = feed.code;
          newAssignment.feedName = feed.name;
        }
      } catch { /* Feed lookup failed */ }

      program.feedAssignments = [...program.feedAssignments, newAssignment];
      program.lastModifiedBy = user.sub;
      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'ADD_FEED_ASSIGNMENT',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { feedId: assignment.feedId },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('addFeedAssignment', error);
    }
  }

  /**
   * Update an existing feed assignment in a program
   */
  @Mutation(() => FeedingProgram, { description: 'Yem atamasini guncelle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedAssignment(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('feedId', { type: () => ID }) feedId: string,
    @Args('assignment') assignment: FeedAssignmentInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'updateFeedAssignment');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', { extensions: { code: 'NOT_FOUND' } });
      }

      if (!program.isEditable() && program.status !== FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError(
          `Cannot modify feed assignments in '${program.status}' status`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      const idx = program.feedAssignments.findIndex((a) => a.feedId === feedId);
      if (idx === -1) {
        throw new GraphQLError(`Feed assignment with feedId '${feedId}' not found in program`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const existingAssignment = program.feedAssignments[idx]!;
      let feedCode = existingAssignment.feedCode;
      let feedName = existingAssignment.feedName;
      if (assignment.feedId !== feedId) {
        try {
          const feedRepo = TenantScopedRepository.create(this.dataSource, Feed, tenantId);
          const feed = await feedRepo.findOne({ where: { id: assignment.feedId }, select: ['id', 'code', 'name'] });
          if (feed) {
            feedCode = feed.code;
            feedName = feed.name;
          }
        } catch { /* Feed lookup failed */ }
      }

      program.feedAssignments[idx] = {
        feedId: assignment.feedId,
        feedCode,
        feedName,
        minWeightG: assignment.minWeightG,
        maxWeightG: assignment.maxWeightG,
        priority: assignment.priority ?? existingAssignment.priority,
        notes: assignment.notes,
      };

      program.lastModifiedBy = user.sub;
      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'UPDATE_FEED_ASSIGNMENT',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { feedId, newFeedId: assignment.feedId },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('updateFeedAssignment', error);
    }
  }

  /**
   * Remove a feed assignment from a program
   */
  @Mutation(() => FeedingProgram, { description: 'Yem atamasini kaldir' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeFeedAssignment(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('feedId', { type: () => ID }) feedId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'removeFeedAssignment');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', { extensions: { code: 'NOT_FOUND' } });
      }

      if (!program.isEditable() && program.status !== FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError(
          `Cannot modify feed assignments in '${program.status}' status`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      const originalLength = program.feedAssignments.length;
      program.feedAssignments = program.feedAssignments.filter((a) => a.feedId !== feedId);

      if (program.feedAssignments.length === originalLength) {
        throw new GraphQLError(`Feed assignment with feedId '${feedId}' not found in program`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (program.feedAssignments.length === 0 && program.status === FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError('Cannot remove the last feed assignment from an active program', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      program.lastModifiedBy = user.sub;
      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'REMOVE_FEED_ASSIGNMENT',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { feedId },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('removeFeedAssignment', error);
    }
  }

  /**
   * Update FCR table for a program
   */
  @Mutation(() => FeedingProgram, { description: 'FCR tablosunu guncelle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFCRTable(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('fcrTable') fcrTable: FCRTableInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'updateFCRTable');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', { extensions: { code: 'NOT_FOUND' } });
      }

      if (!program.isEditable() && program.status !== FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError(
          `Cannot modify FCR table in '${program.status}' status`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      program.fcrTable = this.mapFCRTable(fcrTable);

      const validation = program.validateFCRTable();
      if (!validation.valid) {
        throw new GraphQLError(`Invalid FCR table: ${validation.errors.join(', ')}`, {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      program.lastModifiedBy = user.sub;
      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'UPDATE_FCR_TABLE',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('updateFCRTable', error);
    }
  }

  /**
   * Clone a feeding program
   */
  @Mutation(() => FeedingProgram, { description: 'Programi kopyala' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cloneFeedingProgram(
    @Args('sourceId', { type: () => ID }) sourceId: string,
    @Args('newName') newName: string,
    @Args('newCode') newCode: string,
    @Args('startDate') startDate: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'cloneFeedingProgram');

    try {
      const sourceProgram = await this.feedingProgramRepository.findOne({
        where: { id: sourceId, tenantId },
      });

      if (!sourceProgram) {
        throw new GraphQLError('Source feeding program not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const existingProgram = await this.feedingProgramRepository.findOne({
        where: { tenantId, code: newCode },
      });

      if (existingProgram) {
        throw new GraphQLError(`Program with code '${newCode}' already exists`, {
          extensions: { code: 'CONFLICT' },
        });
      }

      const clonedProgram = await this.feedingProgramService.createProgram(
        {
          name: newName,
          code: newCode,
          description: sourceProgram.description
            ? `Cloned from ${sourceProgram.code}. ${sourceProgram.description}`
            : `Cloned from ${sourceProgram.code}`,
          feedAssignments: [...sourceProgram.feedAssignments],
          fcrTable: sourceProgram.fcrTable ? { ...sourceProgram.fcrTable } : undefined,
          startDate: new Date(startDate),
          settings: sourceProgram.settings ? { ...sourceProgram.settings } : undefined,
        },
        user.sub,
        tenantId,
      );

      this.auditLog({
        action: 'CLONE',
        resourceType: 'FeedingProgram',
        resourceId: clonedProgram.id,
        userId: user.sub,
        tenantId,
        details: { sourceId, sourceName: sourceProgram.name },
      });

      return clonedProgram;
    } catch (error) {
      throw this.handleMutationError('cloneFeedingProgram', error);
    }
  }

  /**
   * Update program settings
   */
  @Mutation(() => FeedingProgram, { description: 'Program ayarlarini guncelle' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateProgramSettings(
    @Args('feedingProgramId', { type: () => ID }) feedingProgramId: string,
    @Args('settings') settings: ProgramSettingsInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<FeedingProgram> {
    this.validateTenantAndUser(tenantId, user, 'updateProgramSettings');

    try {
      const program = await this.feedingProgramRepository.findOne({
        where: { id: feedingProgramId, tenantId },
      });

      if (!program) {
        throw new GraphQLError('Feeding program not found', { extensions: { code: 'NOT_FOUND' } });
      }

      if (!program.isEditable() && program.status !== FeedingProgramStatus.ACTIVE) {
        throw new GraphQLError(
          `Cannot modify settings in '${program.status}' status`,
          { extensions: { code: 'BAD_REQUEST' } },
        );
      }

      program.settings = {
        ...program.settings,
        ...(settings.autoTransition !== undefined && { autoTransition: settings.autoTransition }),
        ...(settings.transitionBuffer !== undefined && { transitionBuffer: settings.transitionBuffer }),
        ...(settings.notifyOnTransition !== undefined && { notifyOnTransition: settings.notifyOnTransition }),
        ...(settings.fcrSource !== undefined && { fcrSource: settings.fcrSource }),
        ...(settings.defaultMealsPerDay !== undefined && { defaultMealsPerDay: settings.defaultMealsPerDay }),
        ...(settings.minFeedingRatePercent !== undefined && { minFeedingRatePercent: settings.minFeedingRatePercent }),
        ...(settings.maxFeedingRatePercent !== undefined && { maxFeedingRatePercent: settings.maxFeedingRatePercent }),
      };

      const validation = program.validateSettings();
      if (!validation.valid) {
        throw new GraphQLError(`Invalid settings: ${validation.errors.join(', ')}`, {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      program.lastModifiedBy = user.sub;
      const saved = await this.feedingProgramRepository.save(program);

      this.auditLog({
        action: 'UPDATE_SETTINGS',
        resourceType: 'FeedingProgram',
        resourceId: feedingProgramId,
        userId: user.sub,
        tenantId,
        details: { settings },
      });

      return saved;
    } catch (error) {
      throw this.handleMutationError('updateProgramSettings', error);
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
    // A lost/wrong tenant context (TenantContextError) is the platform's "data
    // disappears" failure mode — it must surface, never be masked as an empty
    // result. Re-throw it instead of swallowing it to null/[].
    if (error instanceof TenantContextError) {
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
