import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetAllCertificationsQuery } from '../queries/get-all-certifications.query';
import { EmployeeCertification } from '../entities/employee-certification.entity';

export interface PaginatedEmployeeCertifications {
  items: EmployeeCertification[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetAllCertificationsQuery)
export class GetAllCertificationsHandler
  implements IQueryHandler<GetAllCertificationsQuery>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certificationRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(query: GetAllCertificationsQuery): Promise<PaginatedEmployeeCertifications> {
    const { tenantId, employeeId, certificationTypeId, status, category, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

    const queryBuilder = this.certificationRepository
      .createQueryBuilder('ec')
      .leftJoinAndSelect('ec.employee', 'employee')
      .leftJoinAndSelect('ec.certificationType', 'certificationType')
      .where('ec.tenantId = :tenantId', { tenantId })
      .andWhere('ec.isDeleted = false');

    if (employeeId) {
      queryBuilder.andWhere('ec.employeeId = :employeeId', { employeeId });
    }

    if (certificationTypeId) {
      queryBuilder.andWhere('ec.certificationTypeId = :certificationTypeId', { certificationTypeId });
    }

    if (status) {
      queryBuilder.andWhere('ec.status = :status', { status });
    }

    if (category) {
      queryBuilder.andWhere('certificationType.category = :category', { category });
    }

    queryBuilder.orderBy('ec.expiryDate', 'ASC', 'NULLS LAST');

    const [items, total] = await queryBuilder
      .skip(effectiveOffset)
      .take(effectiveLimit)
      .getManyAndCount();

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
