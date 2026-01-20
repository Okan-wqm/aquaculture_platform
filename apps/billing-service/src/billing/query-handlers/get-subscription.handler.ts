import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetSubscriptionQuery } from '../queries/get-subscription.query';
import { Subscription } from '../entities/subscription.entity';

@Injectable()
@QueryHandler(GetSubscriptionQuery)
export class GetSubscriptionHandler
  implements IQueryHandler<GetSubscriptionQuery, Subscription | null>
{
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

  async execute(query: GetSubscriptionQuery): Promise<Subscription | null> {
    const { tenantId } = query;

    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
      relations: ['invoices'],
      order: { createdAt: 'DESC' },
    });

    return subscription;
  }
}
