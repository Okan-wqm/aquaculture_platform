import { Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { TenantScopedRepository } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import { GetSubscriptionQuery } from '../queries/get-subscription.query';
import { Subscription } from '../entities/subscription.entity';

/** TTL for cached subscription data (60 seconds) */
const SUBSCRIPTION_CACHE_TTL_S = 60;

@Injectable()
@QueryHandler(GetSubscriptionQuery)
export class GetSubscriptionHandler
  implements IQueryHandler<GetSubscriptionQuery, Subscription | null>
{
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(query: GetSubscriptionQuery): Promise<Subscription | null> {
    const { tenantId } = query;

    // Serve from cache if available — subscription data changes infrequently
    if (this.redisService) {
      const cacheKey = `subscription:${tenantId}`;
      const cached = await this.redisService.getJson<Subscription>(cacheKey);
      if (cached) return cached;
    }

    const subscriptionRepo = TenantScopedRepository.create(this.dataSource, Subscription, tenantId);

    const subscription = await subscriptionRepo.findOne({
      where: {},
      order: { createdAt: 'DESC' },
    });

    if (subscription && this.redisService) {
      const cacheKey = `subscription:${tenantId}`;
      await this.redisService.setJson(cacheKey, subscription, SUBSCRIPTION_CACHE_TTL_S);
    }

    return subscription;
  }
}
