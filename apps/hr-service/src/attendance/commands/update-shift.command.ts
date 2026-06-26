import { ShiftType, WeekDay, BreakPeriod } from '../entities/shift.entity';

/**
 * UpdateShiftCommand — carries the tenant/user context plus the partial
 * UpdateShiftInput fields. `id` is required; every mutable shift attribute is
 * optional so the handler applies ONLY the fields the caller actually sent
 * (undefined === "leave unchanged"). Mirrors CreateShiftCommand's shape,
 * minus `code` (UpdateShiftInput is immutable on code) plus `isActive`
 * (CreateShiftInput has no isActive — shifts are created active).
 *
 * Note: earlyClockInMinutes / lateClockOutMinutes are NOT updatable via this
 * command because UpdateShiftInput does not expose them; adding them here
 * would be dead carry since the resolver has no source field to populate.
 */
export class UpdateShiftCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly id: string,
    public readonly name?: string,
    public readonly description?: string,
    public readonly shiftType?: ShiftType,
    public readonly startTime?: string,
    public readonly endTime?: string,
    public readonly totalMinutes?: number,
    public readonly breakMinutes?: number,
    public readonly breakPeriods?: BreakPeriod[],
    public readonly workDays?: WeekDay[],
    public readonly crossesMidnight?: boolean,
    public readonly graceMinutes?: number,
    public readonly isActive?: boolean,
    public readonly colorCode?: string,
    public readonly displayOrder?: number,
  ) {}
}
