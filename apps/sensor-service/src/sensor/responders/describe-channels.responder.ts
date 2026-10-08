import { isValidUUID } from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  type DescribeSensorChannelsRequest,
  type DescribeSensorChannelsResponse,
  isDescribeSensorChannelsRequest,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
} from '@platform/event-contracts';

import { ChannelDescriptionService } from '../services/channel-description.service';

/** A request that does not match the contract; the caller sees it as a failure. */
export class SensorChannelRequestInvalidError extends Error {
  constructor() {
    super('Channel description request does not match its contract');
    this.name = 'SENSOR_CHANNEL_REQUEST_INVALID';
  }
}

/** The sensor read behind the answer failed; the caller decides what to show. */
export class SensorChannelAuthorityUnavailableError extends Error {
  constructor() {
    super('Sensor channel authority is temporarily unavailable');
    this.name = 'SENSOR_CHANNEL_AUTHORITY_UNAVAILABLE';
  }
}

/**
 * Core-NATS responder: what each asked-about sensor channel is, now.
 *
 * Farm binds water-chemistry inputs by (sensorId, channelKey) and copies
 * nothing about the channel; it asks here when it binds and when it reads.
 * The answer is ChannelDescriptionService's, the same one the
 * `channelsByKey` query returns. Broker ACLs decide who may publish the
 * subject (services.yaml); the tenant is the request's, and every read runs
 * inside that tenant's RLS boundary, so a key of another tenant's sensor is
 * answered as no sensor. It cannot be used to list a tenant's channels.
 */
@Injectable()
export class DescribeChannelsResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DescribeChannelsResponder.name);
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly requestReply: NatsRequestReply,
    private readonly descriptions: ChannelDescriptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<
      DescribeSensorChannelsRequest,
      DescribeSensorChannelsResponse
    >(SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE, (request) => this.describe(request), {
      queue: 'sensor-service',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  async describe(request: DescribeSensorChannelsRequest): Promise<DescribeSensorChannelsResponse> {
    if (!isDescribeSensorChannelsRequest(request) || !isValidUUID(request.tenantId)) {
      throw new SensorChannelRequestInvalidError();
    }
    try {
      return { channels: await this.descriptions.describe(request.tenantId, request.channels) };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'sensor_channel_authority_unavailable',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new SensorChannelAuthorityUnavailableError();
    }
  }
}
