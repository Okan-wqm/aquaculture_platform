import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetExpiredCertificationsQuery } from '../queries/get-expired-certifications.query';
import { EmployeeCertification, CertificationStatus } from '../entities/employee-certification.entity';

@QueryHandler(GetExpiredCertificationsQuery)
export class GetExpiredCertificationsHandler
  implements IQueryHandler<GetExpiredCertificationsQuery>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(query: GetExpiredCertificationsQuery): Promise<EmployeeCertification[]> {
    const { tenantId, departmentId } = query;

    const today = new Date();

    const queryBuilder = this.certRepository
      .createQueryBuilder('ec')
      .leftJoinAndSelect('ec.certificationType', 'certificationType')
      .leftJoinAndSelect('ec.employee', 'employee')
      .where('ec.tenantId = :tenantId', { tenantId })
      .andWhere('ec.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [CertificationStatus.REVOKED],
      })
      .andWhere('ec.expiryDate IS NOT NULL')
      .andWhere('ec.expiryDate < :today', { today })
      .andWhere('ec.isDeleted = false')
      .orderBy('ec.expiryDate', 'ASC')
      .take(100);

    // FIX: Use departmentHrId - Employee entity has departmentHrId, not departmentId
    if (departmentId) {
      queryBuilder.andWhere('employee.departmentHrId = :departmentId', { departmentId });
    }

    return queryBuilder.getMany();
  }
}
