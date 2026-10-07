import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  FARM_TIME_ZONE_QUERY_SUBJECTS,
  isResolveFarmTimeZonesRequest,
  type ResolveFarmTimeZonesRequest,
  type ResolveFarmTimeZonesResponse,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { SiteTimeZoneService } from '../services/site-time-zone.service';

/** A request that does not match the contract; the caller sees it as a failure. */
export class FarmTimeZoneRequestInvalidError extends Error {
  constructor() {
    super('Time-zone request does not match its contract');
    this.name = 'FARM_TIME_ZONE_REQUEST_INVALID';
  }
}

/** The farm read behind the answer failed; the caller decides what to show. */
export class FarmTimeZoneAuthorityUnavailableError extends Error {
  constructor() {
    super('Farm time-zone authority is temporarily unavailable');
    this.name = 'FARM_TIME_ZONE_AUTHORITY_UNAVAILABLE';
  }
}

/**
 * Core-NATS responder: which zone each asked-about site's day is counted in.
 *
 * Answered by SiteTimeZoneService, the resolver feeding uses, so a sensor
 * chart's day and a feeding day are the same day. Broker ACLs decide who may
 * publish the subject (services.yaml); caller identity is never read from
 * message headers. The reply names a zone only for each site asked about that
 * set its own zone (and exists, not deleted); every other site uses the
 * tenant zone. It cannot be used to list a tenant's sites.
 */
@Injectable()
export class ResolveTimeZonesResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResolveTimeZonesResponder.name);
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
    private readonly siteTimeZones: SiteTimeZoneService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<
      ResolveFarmTimeZonesRequest,
      ResolveFarmTimeZonesResponse
    >(FARM_TIME_ZONE_QUERY_SUBJECTS.RESOLVE, (request) => this.resolve(request), {
      queue: 'farm-service',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  async resolve(request: ResolveFarmTimeZonesRequest): Promise<ResolveFarmTimeZonesResponse> {
    if (!isResolveFarmTimeZonesRequest(request) || !isValidUUID(request.tenantId)) {
      throw new FarmTimeZoneRequestInvalidError();
    }
    // A site id that is not a uuid cannot name a site; it gets the tenant zone.
    const siteIds = [...new Set(request.siteIds.filter((siteId) => isValidUUID(siteId)))];
    try {
      return await runInTenantRead(
        this.dataSource,
        'farm',
        request.tenantId,
        async (queryRunner) => {
          const zones = await this.siteTimeZones.siteZones(queryRunner.manager, request.tenantId);
          const siteZones: Record<string, string> = {};
          for (const siteId of siteIds) {
            const own = zones.ownZoneOf(siteId);
            if (own !== undefined) siteZones[siteId] = own;
          }
          return { tenantZone: zones.tenantZone, siteZones };
        },
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'farm_time_zone_authority_unavailable',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new FarmTimeZoneAuthorityUnavailableError();
    }
  }
}
