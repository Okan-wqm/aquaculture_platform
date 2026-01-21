import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';

import { VfdReading } from '../entities/vfd-reading.entity';
import { VfdDataReaderService, TimeRange } from '../services/vfd-data-reader.service';

/**
 * VFD Reading GraphQL Resolver
 */
@Resolver('VfdReading')
export class VfdReadingResolver {
  constructor(
    private readonly dataReaderService: VfdDataReaderService
  ) {}

  /**
   * Get latest reading for a device
   */
  @Query('vfdLatestReading')
  async getLatestReading(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ): Promise<VfdReading | null> {
    return this.dataReaderService.getLatestReading(vfdDeviceId, context.tenantId);
  }

  /**
   * Get readings for a device within a time range
   */
  @Query('vfdReadings')
  async getReadings(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Args('limit') limit: number,
    @Context() context: { tenantId: string }
  ): Promise<VfdReading[]> {
    const timeRange: TimeRange | undefined = from && to ? { from, to } : undefined;
    return this.dataReaderService.getReadings(
      vfdDeviceId,
      context.tenantId,
      timeRange,
      limit
    );
  }

  /**
   * Get reading statistics for a device
   */
  @Query('vfdReadingStats')
  async getReadingStats(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Context() context: { tenantId: string }
  ) {
    return this.dataReaderService.getReadingStats(
      vfdDeviceId,
      context.tenantId,
      { from, to }
    );
  }

  /**
   * Read current parameters from device
   */
  @Mutation('readVfdParameters')
  async readParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.dataReaderService.readParameters(vfdDeviceId, context.tenantId);
  }

  /**
   * Read only critical parameters (faster)
   */
  @Mutation('readVfdCriticalParameters')
  async readCriticalParameters(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.dataReaderService.readCriticalParameters(vfdDeviceId, context.tenantId);
  }

  /**
   * Delete old readings
   */
  @Mutation('deleteOldVfdReadings')
  async deleteOldReadings(
    @Args('olderThan') olderThan: Date,
    @Context() context: { tenantId: string }
  ): Promise<number> {
    return this.dataReaderService.deleteOldReadings(context.tenantId, olderThan);
  }

  // Note: In production, subscriptions would be implemented with Redis PubSub
  // @Subscription('vfdReadingUpdated')
  // async vfdReadingUpdated(
  //   @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string
  // ) {
  //   return pubsub.asyncIterator(`vfd_reading_${vfdDeviceId}`);
  // }
}
