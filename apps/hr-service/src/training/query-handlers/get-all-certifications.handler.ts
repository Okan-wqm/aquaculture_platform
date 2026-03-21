import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetAllCertificationsQuery } from '../queries/get-all-certifications.query';
import { EmployeeCertification } from '../entities/employee-certification.entity';

@QueryHandler(GetAllCertificationsQuery)
export class GetAllCertificationsHandler
  implements IQueryHandler<GetAllCertificationsQuery>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certificationRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(query: GetAllCertificationsQuery): Promise<PaginatedQueryResult<EmployeeCertification>> {
    const { tenantId, employeeId, certificationTypeId, status, category } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

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
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
