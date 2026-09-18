/**
 * Feeding farm-AI read-only NATS responder (PR-4, Production specialist).
 * Four `request.farm.ai.*` subjects backed EXCLUSIVELY by the feeding and
 * feed modules' existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isDailyFeedingPlanRequest,
  isFeedProtocolsRequest,
  isFeedingSummaryRequest,
  isSiteFeedConsumptionRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import {
  DailyFeedingPlanResult,
  GetDailyFeedingPlanQuery,
} from '../queries/get-daily-feeding-plan.query';
import { FeedingSummaryResult, GetFeedingSummaryQuery } from '../queries/get-feeding-summary.query';
import {
  GetSiteFeedConsumptionQuery,
  SiteFeedConsumptionResult,
} from '../queries/get-site-feed-consumption.query';
import { ListFeedingProtocolsQuery } from '../../feed/queries/list-feeding-protocols.query';
import { FeedingProtocol } from '../../feed/entities/feeding-protocol.entity';
import { PaginatedQueryResult } from '@platform/cqrs';
import {
  DailyFeedingPlanDto,
  FeedProtocolDto,
  FeedingSummaryDto,
  SiteFeedConsumptionDto,
  projectDailyFeedingPlan,
  projectFeedProtocol,
  projectFeedingSummary,
  projectSiteFeedConsumption,
} from './projections';

@Controller()
export class FeedingAiQueryResponder {
  private readonly logger = new Logger(FeedingAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN)
  async dailyPlan(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<DailyFeedingPlanDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isDailyFeedingPlanRequest,
      async (req) =>
        projectDailyFeedingPlan(
          await this.queryBus.execute<GetDailyFeedingPlanQuery, DailyFeedingPlanResult>(
            new GetDailyFeedingPlanQuery(
              req.tenantId,
              req.siteId,
              new Date(req.date),
              req.departmentId,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY)
  async summary(@Payload() payload: unknown): Promise<AiQueryReply<FeedingSummaryDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFeedingSummaryRequest,
      async (req) =>
        projectFeedingSummary(
          await this.queryBus.execute<GetFeedingSummaryQuery, FeedingSummaryResult>(
            new GetFeedingSummaryQuery(
              req.tenantId,
              req.entityType,
              req.entityId,
              req.fromDate ? new Date(req.fromDate) : undefined,
              req.toDate ? new Date(req.toDate) : undefined,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION)
  async siteConsumption(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<SiteFeedConsumptionDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isSiteFeedConsumptionRequest,
      async (req) =>
        projectSiteFeedConsumption(
          await this.queryBus.execute<
            GetSiteFeedConsumptionQuery,
            SiteFeedConsumptionResult
          >(
            new GetSiteFeedConsumptionQuery(
              req.tenantId,
              req.siteId,
              req.fromDate,
              req.toDate,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS)
  async protocols(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<FeedProtocolDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFeedProtocolsRequest,
      async (req) => {
        const limit = clampListLimit(
          req.limit,
          FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
        );
        const result = await this.queryBus.execute<
          ListFeedingProtocolsQuery,
          PaginatedQueryResult<FeedingProtocol>
        >(new ListFeedingProtocolsQuery(req.tenantId, undefined, { page: 1, limit }));
        return toBoundedList(
          result.data,
          limit,
          projectFeedProtocol,
          result.pagination.total,
        );
      },
    );
  }
}
