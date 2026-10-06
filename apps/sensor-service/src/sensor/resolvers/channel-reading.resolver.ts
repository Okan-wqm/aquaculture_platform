import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { Tenant } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { AggregationInterval } from '../dto/aggregated-reading.dto';
import { ChannelLatestValue, ChannelSeriesResponse } from '../dto/channel-reading.dto';
import { ChannelReadingQueryService } from '../services/channel-reading-query.service';

/**
 * Channel-generic reading queries (SENSOR-HIGH-138). Read-only; the tenant
 * comes from the verified request context and every read runs inside that
 * tenant's RLS boundary (ChannelReadingQueryService → runInTenantRead).
 */
@Resolver(() => ChannelLatestValue)
@UseGuards(TenantGuard)
export class ChannelReadingResolver {
  constructor(private readonly channelReadings: ChannelReadingQueryService) {}

  @Query(() => [ChannelLatestValue], {
    name: 'channelLatestValues',
    description:
      'Each enabled channel of the given sensors with its last-known value (≤100 sensors)',
  })
  async channelLatestValues(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<ChannelLatestValue[]> {
    return this.channelReadings.getLatestValues(sensorIds, tenantId);
  }

  @Query(() => ChannelSeriesResponse, {
    name: 'channelSeries',
    description: 'Bucketed history of every enabled channel of one sensor over a time range',
  })
  async channelSeries(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('startTime') startTime: Date,
    @Args('endTime') endTime: Date,
    @Tenant() tenantId: string,
    @Args('interval', { type: () => AggregationInterval, nullable: true })
    interval?: AggregationInterval,
  ): Promise<ChannelSeriesResponse> {
    return this.channelReadings.getSeries(sensorId, tenantId, startTime, endTime, interval);
  }
}
