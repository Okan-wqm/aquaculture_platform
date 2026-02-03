import { WeekDay } from '../../attendance/entities/shift.entity';

export class CreateWeeklyPlanCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly weekStartDate: string,
    public readonly defaultShiftId?: string,
    public readonly defaultOffDays?: WeekDay[],
    public readonly notes?: string,
  ) {}
}
