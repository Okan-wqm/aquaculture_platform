import { ClockMethod, GeoLocation } from '../entities/attendance-record.entity';

export class ClockInCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly method: ClockMethod,
    public readonly location?: GeoLocation,
    public readonly remarks?: string,
    public readonly workAreaId?: string,
  ) {}
}
