/**
 * Get Feeding Protocol Query Handler
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetFeedingProtocolQuery } from '../queries/get-feeding-protocol.query';
import { FeedingProtocol } from '../entities/feeding-protocol.entity';

@QueryHandler(GetFeedingProtocolQuery)
export class GetFeedingProtocolHandler implements IQueryHandler<GetFeedingProtocolQuery> {
  constructor(
    @InjectRepository(FeedingProtocol)
    private readonly feedingProtocolRepository: Repository<FeedingProtocol>,
  ) {}

  async execute(query: GetFeedingProtocolQuery): Promise<FeedingProtocol | null> {
    const { id, tenantId } = query;

    return this.feedingProtocolRepository.findOne({
      where: { id, tenantId },
      relations: ['feed'],
    });
  }
}
