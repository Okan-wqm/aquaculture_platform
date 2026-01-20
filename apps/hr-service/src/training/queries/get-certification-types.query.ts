import { CertificationCategory } from '../entities/certification-type.entity';

export class GetCertificationTypesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly category?: CertificationCategory,
    public readonly isActive?: boolean,
  ) {}
}
