import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { Tenant } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { AggregationInterval } from '../dto/aggregated-reading.dto';
import {
  ChannelDataBounds,
  SeriesDisplayTimeZone,
  ChannelLatestValue,
  ChannelSeriesResponse,
} from '../dto/channel-reading.dto';
import {
  ChannelsByKeyInput,
  SensorChannelDescriptionType,
  toDescriptionType,
} from '../dto/channel-description.dto';
import { ChannelDescriptionService } from '../services/channel-description.service';
import { ChannelReadingQueryService } from '../services/channel-reading-query.service';

/**
 * Channel-generic reading queries (SENSOR-HIGH-138). Read-only; the tenant
 * comes from the verified request context and every read runs inside that
 * tenant's RLS boundary (ChannelReadingQueryService and
 * ChannelDescriptionService → runInTenantRead).
 */
@Resolver(() => ChannelLatestValue)
@UseGuards(TenantGuard)
export class ChannelReadingResolver {
  constructor(
    private readonly channelReadings: ChannelReadingQueryService,
    private readonly channelDescriptions: ChannelDescriptionService,
  ) {}

  @Query(() => [SensorChannelDescriptionType], {
    name: 'channelsByKey',
    description:
      'What each (sensorId, channelKey) is now (≤100): presence, sensor location, quantity, unit, last value — disabled channels included',
  })
  async channelsByKey(
    @Args('input') input: ChannelsByKeyInput,
    @Tenant() tenantId: string,
  ): Promise<SensorChannelDescriptionType[]> {
    const descriptions = await this.channelDescriptions.describe(tenantId, input.keys);
    return descriptions.map(toDescriptionType);
  }

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

  @Query(() => SeriesDisplayTimeZone, {
    name: 'seriesDisplayTimeZone',
    description:
      "The zone a page of these sensors' charts is shown and picked in (≤1000): their shared site zone, else the tenant's",
  })
  async seriesDisplayTimeZone(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<SeriesDisplayTimeZone> {
    return this.channelReadings.getDisplayTimeZone(sensorIds, tenantId);
  }

  @Query(() => [ChannelDataBounds], {
    name: 'channelDataBounds',
    description:
      "The first and last stored sample of each channel of the given sensors (≤100) — where a sensor's history starts and ends",
  })
  async channelDataBounds(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<ChannelDataBounds[]> {
    return this.channelReadings.getDataBounds(sensorIds, tenantId);
  }
}
