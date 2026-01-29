import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetSubscriptionQuery } from '../queries/get-subscription.query';
import { Subscription } from '../entities/subscription.entity';

@Injectable()
@QueryHandler(GetSubscriptionQuery)
export class GetSubscriptionHandler
  implements IQueryHandler<GetSubscriptionQuery, Subscription | null>
{
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetSubscriptionQuery): Promise<Subscription | null> {
    const { tenantId } = query;

    const subscriptionRepo = this.dataSource.getRepository(Subscription);

    const subscription = await subscriptionRepo.findOne({
      where: { tenantId },
      relations: ['invoices'],
      order: { createdAt: 'DESC' },
    });

    return subscription;
  }
}
