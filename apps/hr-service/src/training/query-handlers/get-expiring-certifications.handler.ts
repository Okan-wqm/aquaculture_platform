import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThan, Not, In } from 'typeorm';
import { GetExpiringCertificationsQuery } from '../queries/get-expiring-certifications.query';
import { EmployeeCertification, CertificationStatus } from '../entities/employee-certification.entity';

@QueryHandler(GetExpiringCertificationsQuery)
export class GetExpiringCertificationsHandler
  implements IQueryHandler<GetExpiringCertificationsQuery>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(query: GetExpiringCertificationsQuery): Promise<EmployeeCertification[]> {
    const { tenantId, daysUntilExpiry, departmentId } = query;

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysUntilExpiry);

    const today = new Date();

    const queryBuilder = this.certRepository
      .createQueryBuilder('ec')
      .leftJoinAndSelect('ec.certificationType', 'certificationType')
      .leftJoinAndSelect('ec.employee', 'employee')
      .where('ec.tenantId = :tenantId', { tenantId })
      .andWhere('ec.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [CertificationStatus.REVOKED, CertificationStatus.EXPIRED],
      })
      .andWhere('ec.expiryDate IS NOT NULL')
      .andWhere('ec.expiryDate <= :expiryDate', { expiryDate })
      .andWhere('ec.expiryDate > :today', { today })
      .andWhere('ec.isDeleted = false')
      .orderBy('ec.expiryDate', 'ASC');

    if (departmentId) {
      queryBuilder.andWhere('employee.departmentId = :departmentId', { departmentId });
    }

    return queryBuilder.getMany();
  }
}
