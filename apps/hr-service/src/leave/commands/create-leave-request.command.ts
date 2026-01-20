import { HalfDayPeriod } from '../entities/leave-request.entity';

export class CreateLeaveRequestCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly leaveTypeId: string,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly totalDays: number,
    public readonly isHalfDayStart: boolean = false,
    public readonly isHalfDayEnd: boolean = false,
    public readonly halfDayPeriod?: HalfDayPeriod,
    public readonly reason?: string,
    public readonly contactDuringLeave?: string,
  ) {}
}
