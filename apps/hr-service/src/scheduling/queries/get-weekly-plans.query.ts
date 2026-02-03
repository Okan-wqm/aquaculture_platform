import { WeeklyPlanStatus } from '../entities/weekly-plan.entity';

export class GetWeeklyPlansQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly departmentId?: string,
    public readonly siteId?: string,
    public readonly weekStartDate?: string,
    public readonly status?: WeeklyPlanStatus,
    public readonly limit: number = 20,
    public readonly offset: number = 0,
  ) {}
}
