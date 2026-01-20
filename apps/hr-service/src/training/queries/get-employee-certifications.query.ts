import { CertificationStatus } from '../entities/employee-certification.entity';

export class GetEmployeeCertificationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly status?: CertificationStatus,
  ) {}
}
