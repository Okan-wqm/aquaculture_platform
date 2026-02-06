import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { TenantGuard, Tenant } from '@platform/backend-common';

import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdReadingStats } from '../dto/vfd-stats.dto';
import { VfdReadResultDto } from '../dto/vfd-read-result.dto';
import { VfdDataReaderService, TimeRange } from '../services/vfd-data-reader.service';

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
   * Get reading statistics for a device
   */
  @Query(() => VfdReadingStats, { name: 'vfdReadingStats', nullable: true })
  async getReadingStats(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('from', { type: () => Date }) from: Date,
    @Args('to', { type: () => Date }) to: Date,
    @Tenant() tenantId: string
  ): Promise<VfdReadingStats | null> {
    return this.dataReaderService.getReadingStats(
      vfdDeviceId,
      tenantId,
      { from, to }
    );
  }

  /**
   * Read current parameters from device
   */
  @Mutation(() => VfdReadResultDto, { name: 'readVfdParameters', nullable: true })
  async readParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdReadResultDto | null> {
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
