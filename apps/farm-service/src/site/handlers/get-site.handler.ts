/**
 * Get Site Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSiteQuery } from '../queries/get-site.query';
import { Site } from '../entities/site.entity';

@QueryHandler(GetSiteQuery)
export class GetSiteHandler implements IQueryHandler<GetSiteQuery> {
  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(query: GetSiteQuery): Promise<Site> {
    const { siteId, tenantId, includeRelations } = query;

    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId },
      // relations: includeRelations ? ['departments'] : [],
    });

    // Return null instead of throwing - allows partial data in GraphQL responses
    // The site field is nullable, so this is a valid response
    // This handles connection pool race conditions where search_path might be reset
    if (!site) {
      return null as unknown as Site;
    }

    return site;
  }
}
