import { ShiftType, WeekDay, BreakPeriod } from '../entities/shift.entity';

export class CreateShiftCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly code: string,
    public readonly name: string,
    public readonly startTime: string,
    public readonly endTime: string,
    public readonly shiftType: ShiftType = ShiftType.REGULAR,
    public readonly description?: string,
    public readonly totalMinutes?: number,
    public readonly breakMinutes: number = 0,
    public readonly breakPeriods?: BreakPeriod[],
    public readonly workDays?: WeekDay[],
    public readonly crossesMidnight: boolean = false,
    public readonly graceMinutes: number = 0,
    public readonly earlyClockInMinutes: number = 0,
    public readonly lateClockOutMinutes: number = 0,
    public readonly colorCode?: string,
    public readonly displayOrder: number = 0,
  ) {}
}
