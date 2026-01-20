import { RotationStatus } from '../entities/work-rotation.entity';

export class GetWorkRotationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly workAreaId?: string,
    public readonly status?: RotationStatus,
    public readonly startDate?: string,
    public readonly endDate?: string,
  ) {}
}
