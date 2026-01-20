import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetEmployeeCertificationsQuery } from '../queries/get-employee-certifications.query';
import { EmployeeCertification } from '../entities/employee-certification.entity';

@QueryHandler(GetEmployeeCertificationsQuery)
export class GetEmployeeCertificationsHandler
  implements IQueryHandler<GetEmployeeCertificationsQuery>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(query: GetEmployeeCertificationsQuery): Promise<EmployeeCertification[]> {
    const { tenantId, employeeId, status } = query;

    const queryBuilder = this.certRepository
      .createQueryBuilder('ec')
      .leftJoinAndSelect('ec.certificationType', 'certificationType')
      .where('ec.tenantId = :tenantId', { tenantId })
      .andWhere('ec.employeeId = :employeeId', { employeeId })
      .andWhere('ec.isDeleted = false')
      .orderBy('ec.issueDate', 'DESC');

    if (status) {
      queryBuilder.andWhere('ec.status = :status', { status });
    }

    return queryBuilder.getMany();
  }
}
