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
  Args,
  ID,
  ResolveField,
  Parent,
  ObjectType,
  Field,
  InputType,
} from '@nestjs/graphql';
import { UseGuards, Logger, UnauthorizedException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
import { TenantContextError } from '@aquaculture/backend-common/database';

// Entities
import { FeedingProgram, FeedingProgramStatus } from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { DailyFeedingExecution } from '../entities/daily-feeding-execution.entity';

// ============================================================================
// FILTER INPUT TYPES (not exported from dto/, so define here)
// ============================================================================

import { IsOptional, IsString, IsEnum, IsUUID } from 'class-validator';

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
export class DailyFeedingExecutionConnection extends StandardPaginatedResponse(
  DailyFeedingExecution,
) {}

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
    @Args('filter', { type: () => FeedingProgramFilterInput, nullable: true })
    filter?: FeedingProgramFilterInput,
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
        queryBuilder.andWhere('program.startDate >= :startDateFrom', {
          startDateFrom: filter.startDateFrom,
        });
      }

      if (filter?.startDateTo) {
        queryBuilder.andWhere('program.startDate <= :startDateTo', {
          startDateTo: filter.startDateTo,
        });
      }

      if (filter?.includeInactive === false) {
        queryBuilder.andWhere('program.status != :inactiveStatus', { inactiveStatus: 'INACTIVE' });
      }

      if (filter?.search) {
        // Sanitize search input
        const sanitizedSearch = filter.search.replace(/[%_]/g, '\\$&');
        queryBuilder.andWhere('(program.name ILIKE :search OR program.code ILIKE :search)', {
          search: `%${sanitizedSearch}%`,
        });
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
  @Query(() => DailyFeedingExecution, {
    nullable: true,
    description: 'Gunluk yemleme calistirmasi getir',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async dailyFeedingExecution(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DailyFeedingExecution | null> {
    try {
      if (!tenantId) {
        throw new UnauthorizedException('Tenant context required');
      }

      return await this.dailyFeedingExecutionRepository.findOne({
        where: { id, tenantId },
        relations: ['feedingProgram', 'feedingProgramTank'],
      });
    } catch (error) {
      this.handleError('dailyFeedingExecution', error);
      return null;
    }
  }

  /**
   * List daily feeding executions for a date
   */
  @Query(() => [DailyFeedingExecution], {
    description: 'Belirli tarihteki gunluk yemleme calistirmalarini listele',
  })
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
  @Query(() => [DailyFeedingExecution], {
    description: 'Program icin bugunun yemleme planini getir',
  })
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

      return await this.dailyFeedingExecutionRepository.find({
        where: { feedingProgramId: programId, executionDate: today, tenantId },
        order: { equipmentCode: 'ASC' },
      });
    } catch (error) {
      this.handleError('todaysFeedingPlan', error);
      return [];
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
