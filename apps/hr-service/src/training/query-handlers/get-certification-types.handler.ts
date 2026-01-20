import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetCertificationTypesQuery } from '../queries/get-certification-types.query';
import { CertificationType } from '../entities/certification-type.entity';

@QueryHandler(GetCertificationTypesQuery)
export class GetCertificationTypesHandler implements IQueryHandler<GetCertificationTypesQuery> {
  constructor(
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(query: GetCertificationTypesQuery): Promise<CertificationType[]> {
    const { tenantId, category, isActive } = query;

    const queryBuilder = this.certTypeRepository
      .createQueryBuilder('ct')
      .where('ct.tenantId = :tenantId', { tenantId })
      .andWhere('ct.isDeleted = false')
      .orderBy('ct.displayOrder', 'ASC')
      .addOrderBy('ct.name', 'ASC');

    if (category) {
      queryBuilder.andWhere('ct.category = :category', { category });
    }

    if (isActive !== undefined) {
      queryBuilder.andWhere('ct.isActive = :isActive', { isActive });
    }

    return queryBuilder.getMany();
  }
}
