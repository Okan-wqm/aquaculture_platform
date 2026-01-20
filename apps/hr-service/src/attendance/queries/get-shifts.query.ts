import { ShiftType } from '../entities/shift.entity';

export class GetShiftsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly isActive?: boolean,
    public readonly shiftType?: ShiftType,
  ) {}
}
