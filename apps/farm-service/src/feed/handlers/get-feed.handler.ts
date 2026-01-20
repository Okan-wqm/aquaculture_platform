/**
 * Get Feed Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetFeedQuery } from '../queries/get-feed.query';
import { Feed } from '../entities/feed.entity';

@QueryHandler(GetFeedQuery)
export class GetFeedHandler implements IQueryHandler<GetFeedQuery> {
  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(query: GetFeedQuery): Promise<Feed> {
    const { feedId, tenantId } = query;

    const feed = await this.feedRepository.findOne({
      where: { id: feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed with ID "${feedId}" not found`);
    }

    return feed;
  }
}
