/**
 * WaterQuality GraphQL Resolver
 *
 * Su kalitesi ölçümleri için GraphQL API.
 *
 * @module WaterQuality
 */
import { Resolver, Query, Mutation, Args, ID, ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { WaterQualityMeasurement, WaterQualityStatus } from './entities/water-quality-measurement.entity';
import { Throttle } from '@aquaculture/backend-common/security';
import { WaterQualityService } from './water-quality.service';
import { CreateWaterQualityInput } from './dto/create-water-quality.input';
import { CreateBatchWaterQualityInput } from './dto/create-batch-water-quality.input';
import { UpdateWaterQualityInput } from './dto/update-water-quality.input';
import { WaterQualityFilterInput } from './dto/water-quality-filter.input';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class WaterQualityListResponse extends StandardPaginatedResponse(WaterQualityMeasurement) {}

@ObjectType()
export class WaterQualityStatistics {
  @Field(() => Float, { nullable: true })
  avgTemperature: number | null;

  @Field(() => Float, { nullable: true })
  avgDO: number | null;

  @Field(() => Float, { nullable: true })
  avgPH: number | null;

  @Field(() => Float, { nullable: true })
  avgAmmonia: number | null;

  @Field(() => Float, { nullable: true })
  avgNitrite: number | null;

  @Field(() => Int)
  measurementCount: number;

  @Field(() => Int)
  criticalCount: number;

  @Field(() => Int)
  warningCount: number;

  @Field(() => WaterQualityMeasurement, { nullable: true })
  lastMeasurement: WaterQualityMeasurement | null;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => WaterQualityMeasurement)
@UseGuards(TenantGuard)
export class WaterQualityResolver {
  private readonly logger = new Logger(WaterQualityResolver.name);

  constructor(private readonly waterQualityService: WaterQualityService) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * ID ile ölçüm getirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityMeasurement, { name: 'waterQuality', nullable: true })
  async getWaterQuality(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement> {
    this.logger.debug(`Getting water quality measurement: ${id}`);
    return this.waterQualityService.findById(tenantId, id);
  }

  /**
   * Filtreli liste getirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityListResponse, { name: 'waterQualityMeasurements' })
  async listWaterQualityMeasurements(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => WaterQualityFilterInput, nullable: true })
    filter?: WaterQualityFilterInput,
  ): Promise<IStandardPaginatedResult<WaterQualityMeasurement>> {
    this.logger.debug(`Listing water quality measurements for tenant: ${tenantId}`);
    return this.waterQualityService.findAll(tenantId, filter);
  }

  /**
   * Tank için son ölçümü getirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityMeasurement, { name: 'latestWaterQuality', nullable: true })
  async getLatestWaterQuality(
    @Args('tankId', { type: () => ID }) tankId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement | null> {
    this.logger.debug(`Getting latest water quality for tank: ${tankId}`);
    return this.waterQualityService.findLatestByTank(tenantId, tankId);
  }

  /**
   * Kritik durumda olan tankları listeler
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityMeasurement], { name: 'criticalWaterQuality' })
  async getCriticalWaterQuality(
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.debug(`Getting critical water quality measurements for tenant: ${tenantId}`);
    return this.waterQualityService.findCriticalTanks(tenantId);
  }

  /**
   * Tank için grafik verisi
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityMeasurement], { name: 'waterQualityChart' })
  async getWaterQualityChart(
    @Args('tankId', { type: () => ID }) tankId: string,
    @Args('fromDate') fromDate: Date,
    @Args('toDate') toDate: Date,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.debug(`Getting water quality chart data for tank: ${tankId}`);
    return this.waterQualityService.findByTankForChart(tenantId, tankId, fromDate, toDate);
  }

  /**
   * Tank için istatistikler
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityStatistics, { name: 'waterQualityStatistics' })
  async getWaterQualityStatistics(
    @Args('tankId', { type: () => ID }) tankId: string,
    @Args('days', { type: () => Int, defaultValue: 7 }) days: number,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityStatistics> {
    this.logger.debug(`Getting water quality statistics for tank: ${tankId}, days: ${days}`);
    return this.waterQualityService.getTankStatistics(tenantId, tankId, days);
  }

  /**
   * System-level chart data — aggregates all tanks in a production system
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityMeasurement], { name: 'waterQualityChartBySystem' })
  async getWaterQualityChartBySystem(
    @Args('systemId', { type: () => ID }) systemId: string,
    @Args('fromDate') fromDate: Date,
    @Args('toDate') toDate: Date,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.debug(`Getting water quality chart data for system: ${systemId}`);
    return this.waterQualityService.findBySystemForChart(tenantId, systemId, fromDate, toDate);
  }

  /**
   * System-level statistics — aggregate stats across all tanks in a system
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityStatistics, { name: 'waterQualityStatisticsBySystem' })
  async getWaterQualityStatisticsBySystem(
    @Args('systemId', { type: () => ID }) systemId: string,
    @Args('days', { type: () => Int, defaultValue: 7 }) days: number,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityStatistics> {
    this.logger.debug(`Getting water quality statistics for system: ${systemId}, days: ${days}`);
    return this.waterQualityService.getSystemStatistics(tenantId, systemId, days);
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Yeni ölçüm oluşturur
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Throttle({ limit: 30, ttl: 60 })
  @Mutation(() => WaterQualityMeasurement)
  async createWaterQualityMeasurement(
    @Args('input') input: CreateWaterQualityInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityMeasurement> {
    this.logger.log(`Creating water quality measurement for tenant ${tenantId}`);
    return this.waterQualityService.create(tenantId, {
      ...input,
      measuredBy: input.measuredBy || user.sub,
    });
  }

  /**
   * Batch creation of water quality measurements for multiple equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Throttle({ limit: 10, ttl: 60 })
  @Mutation(() => [WaterQualityMeasurement])
  async createBatchWaterQualityMeasurements(
    @Args('input') input: CreateBatchWaterQualityInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.log(`Creating batch of ${input.measurements.length} WQ measurements for tenant ${tenantId}`);
    return this.waterQualityService.createBatch(tenantId, input, user.sub);
  }

  /**
   * Ölçümü günceller
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityMeasurement)
  async updateWaterQualityMeasurement(
    @Args('input') input: UpdateWaterQualityInput,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityMeasurement> {
    this.logger.log(`Updating water quality measurement ${input.id}`);
    return this.waterQualityService.update(tenantId, input.id, {
      parameters: input.parameters,
      notes: input.notes,
      weatherConditions: input.weatherConditions,
    });
  }

  /**
   * Ölçümü siler
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteWaterQualityMeasurement(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting water quality measurement ${id}`);
    return this.waterQualityService.delete(tenantId, id);
  }
}
