/**
 * Get System Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetSystemQuery } from '../queries/get-system.query';
import { System } from '../entities/system.entity';

@QueryHandler(GetSystemQuery)
export class GetSystemHandler implements IQueryHandler<GetSystemQuery> {
  constructor(
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
  ) {}

  async execute(query: GetSystemQuery): Promise<System | null> {
    const { systemId, tenantId, includeRelations } = query;

    const queryBuilder = this.systemRepository.createQueryBuilder('system');
    queryBuilder.where('system.id = :systemId', { systemId });
    queryBuilder.andWhere('system.tenantId = :tenantId', { tenantId });
    queryBuilder.andWhere('system.isDeleted = :isDeleted', { isDeleted: false });

    if (includeRelations) {
      queryBuilder.leftJoinAndSelect('system.site', 'site');
      queryBuilder.leftJoinAndSelect('system.department', 'department');
      queryBuilder.leftJoinAndSelect('system.parentSystem', 'parentSystem');
      queryBuilder.leftJoinAndSelect('system.childSystems', 'childSystems', 'childSystems.isDeleted = :isDeleted', { isDeleted: false });
    }

    return queryBuilder.getOne();
  }
}
