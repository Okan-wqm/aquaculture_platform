import { CertificationStatus } from '../entities/employee-certification.entity';
import { CertificationCategory } from '../entities/certification-type.entity';

export class GetAllCertificationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly certificationTypeId?: string,
    public readonly status?: CertificationStatus,
    public readonly category?: CertificationCategory,
    public readonly limit: number = 20,
    public readonly offset: number = 0,
  ) {}
}
