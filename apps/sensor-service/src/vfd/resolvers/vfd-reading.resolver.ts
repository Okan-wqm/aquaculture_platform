import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { TenantGuard, Tenant } from '@platform/backend-common';

import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdReadResultDto } from '../dto/vfd-read-result.dto';
import { VfdDataReaderService, TimeRange } from '../services/vfd-data-reader.service';

/**
 * VFD Reading Stats output matching frontend VfdReadingStats interface.
 * Uses period-based approach instead of from/to date range.
 */
import { ObjectType, Field, Float } from '@nestjs/graphql';

@ObjectType('VfdReadingStatsByPeriod')
export class VfdReadingStatsByPeriodDto {
  @Field(() => ID)
  vfdDeviceId!: string;

  @Field()
  period!: string;

  @Field(() => Float, { nullable: true })
  avgFrequency?: number;

  @Field(() => Float, { nullable: true })
  avgCurrent?: number;

  @Field(() => Float, { nullable: true })
  avgPower?: number;

  @Field(() => Float, { nullable: true })
  maxFrequency?: number;

  @Field(() => Float, { nullable: true })
  maxCurrent?: number;

  @Field(() => Float, { nullable: true })
  maxPower?: number;

  @Field(() => Float, { nullable: true })
  totalEnergy?: number;

  @Field(() => Float, { nullable: true })
  runningTime?: number;

  @Field(() => Int)
  faultCount!: number;
}

/**
 * VFD Reading GraphQL Resolver
 */
@Resolver(() => VfdReading)
@UseGuards(TenantGuard)
export class VfdReadingResolver {
  constructor(
    private readonly dataReaderService: VfdDataReaderService
  ) {}

  /**
   * Get latest reading for a device
   */
  @Query(() => VfdReading, { name: 'vfdLatestReading', nullable: true })
  async getLatestReading(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdReading | null> {
    return this.dataReaderService.getLatestReading(vfdDeviceId, tenantId);
  }

  /**
   * Get readings for a device within a time range
   */
  @Query(() => [VfdReading], { name: 'vfdReadings' })
  async getReadings(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('from', { type: () => Date, nullable: true }) from: Date | undefined,
    @Args('to', { type: () => Date, nullable: true }) to: Date | undefined,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 }) limit: number | undefined,
    @Tenant() tenantId: string
  ): Promise<VfdReading[]> {
    const timeRange: TimeRange | undefined = from && to ? { from, to } : undefined;
    return this.dataReaderService.getReadings(
      vfdDeviceId,
      tenantId,
      timeRange,
      limit
    );
  }

  /**
   * Get reading statistics for a device.
   * Supports both period-based (frontend) and date-range approaches.
   * When period is provided, converts to date range automatically.
   * When from/to are provided, uses them directly.
   */
  @Query(() => VfdReadingStatsByPeriodDto, { name: 'vfdReadingStats', nullable: true })
  async getReadingStats(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('period', { type: () => String, nullable: true }) period: string | undefined,
    @Args('from', { type: () => Date, nullable: true }) from: Date | undefined,
    @Args('to', { type: () => Date, nullable: true }) to: Date | undefined,
    @Tenant() tenantId: string
  ): Promise<VfdReadingStatsByPeriodDto | null> {
    // If period is provided, use period-based stats
    if (period) {
      const validPeriod = period as 'hour' | 'day' | 'week' | 'month';
      return this.dataReaderService.getReadingStatsByPeriod(
        vfdDeviceId,
        tenantId,
        validPeriod
      );
    }

    // If from/to are provided, use date-range based stats
    if (from && to) {
      const stats = await this.dataReaderService.getReadingStats(
        vfdDeviceId,
        tenantId,
        { from, to }
      );

      return {
        vfdDeviceId,
        period: 'custom',
        avgFrequency: stats.avgOutputFrequency,
        avgCurrent: stats.avgMotorCurrent,
        avgPower: stats.avgOutputPower,
        maxFrequency: stats.maxOutputFrequency,
        maxCurrent: stats.maxMotorCurrent,
        maxPower: stats.maxOutputPower,
        faultCount: stats.faultCount,
      };
    }

    // Default to last day
    return this.dataReaderService.getReadingStatsByPeriod(
      vfdDeviceId,
      tenantId,
      'day'
    );
  }

  /**
   * Read current parameters from device.
   * Accepts optional parameters filter to read only specific parameters.
   */
  @Mutation(() => VfdReadResultDto, { name: 'readVfdParameters', nullable: true })
  async readParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('parameters', { type: () => [String], nullable: true }) parameters: string[] | undefined,
    @Tenant() tenantId: string
  ): Promise<VfdReadResultDto | null> {
    if (parameters && parameters.length > 0) {
      return this.dataReaderService.readFilteredParameters(vfdDeviceId, tenantId, parameters);
    }
    return this.dataReaderService.readParameters(vfdDeviceId, tenantId);
  }

  /**
   * Read only critical parameters (faster)
   */
  @Mutation(() => VfdReadResultDto, { name: 'readVfdCriticalParameters', nullable: true })
  async readCriticalParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdReadResultDto | null> {
    return this.dataReaderService.readCriticalParameters(vfdDeviceId, tenantId);
  }

  /**
   * Delete old readings
   */
  @Mutation(() => Int, { name: 'deleteOldVfdReadings' })
  async deleteOldReadings(
    @Args('olderThan', { type: () => Date }) olderThan: Date,
    @Tenant() tenantId: string
  ): Promise<number> {
    return this.dataReaderService.deleteOldReadings(tenantId, olderThan);
  }
}
