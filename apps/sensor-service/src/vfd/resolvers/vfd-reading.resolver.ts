import { Resolver, Query, Mutation, Args, ID, Context, Int } from '@nestjs/graphql';

import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdReadingStats } from '../dto/vfd-stats.dto';
import { VfdReadResultDto } from '../dto/vfd-read-result.dto';
import { VfdDataReaderService, TimeRange } from '../services/vfd-data-reader.service';

/**
 * VFD Reading GraphQL Resolver
 */
@Resolver(() => VfdReading)
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
    @Context() context: { tenantId: string }
  ): Promise<VfdReading | null> {
    return this.dataReaderService.getLatestReading(vfdDeviceId, context.tenantId);
  }

  /**
   * Get readings for a device within a time range
   */
  @Query(() => [VfdReading], { name: 'vfdReadings' })
  async getReadings(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('from', { nullable: true }) from?: Date,
    @Args('to', { nullable: true }) to?: Date,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 }) limit?: number,
    @Context() context?: { tenantId: string }
  ): Promise<VfdReading[]> {
    const timeRange: TimeRange | undefined = from && to ? { from, to } : undefined;
    return this.dataReaderService.getReadings(
      vfdDeviceId,
      context?.tenantId || '',
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
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Context() context: { tenantId: string }
  ): Promise<VfdReadingStats | null> {
    return this.dataReaderService.getReadingStats(
      vfdDeviceId,
      context.tenantId,
      { from, to }
    );
  }

  /**
   * Read current parameters from device
   */
  @Mutation(() => VfdReadResultDto, { name: 'readVfdParameters', nullable: true })
  async readParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdReadResultDto | null> {
    return this.dataReaderService.readParameters(vfdDeviceId, context.tenantId);
  }

  /**
   * Read only critical parameters (faster)
   */
  @Mutation(() => VfdReadResultDto, { name: 'readVfdCriticalParameters', nullable: true })
  async readCriticalParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdReadResultDto | null> {
    return this.dataReaderService.readCriticalParameters(vfdDeviceId, context.tenantId);
  }

  /**
   * Delete old readings
   */
  @Mutation(() => Int, { name: 'deleteOldVfdReadings' })
  async deleteOldReadings(
    @Args('olderThan') olderThan: Date,
    @Context() context: { tenantId: string }
  ): Promise<number> {
    return this.dataReaderService.deleteOldReadings(context.tenantId, olderThan);
  }
}
