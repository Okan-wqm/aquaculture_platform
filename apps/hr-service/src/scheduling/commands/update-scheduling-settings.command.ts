import { WeekDay } from '../../attendance/entities/shift.entity';

export class UpdateSchedulingSettingsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly standardWeeklyMinutes?: number,
    public readonly maxOvertimeMinutesPerWeek?: number,
    public readonly maxOvertimeMinutesPerMonth?: number,
    public readonly defaultShiftId?: string,
    public readonly workWeekStartDay?: WeekDay,
    public readonly autoNotifyEmployees?: boolean,
    public readonly notifyDaysBefore?: number,
    public readonly maxConsecutiveWorkDays?: number,
    public readonly minRestMinutesBetweenShifts?: number,
    public readonly allowOvertimeWithoutApproval?: boolean,
  ) {}
}
