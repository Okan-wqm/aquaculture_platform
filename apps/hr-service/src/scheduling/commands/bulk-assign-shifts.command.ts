export interface ShiftAssignment {
  date: string;
  shiftId?: string;
  isOffDay: boolean;
}

export class BulkAssignShiftsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly weeklyPlanId: string,
    public readonly assignments: ShiftAssignment[],
  ) {}
}
