export class AdjustLeaveBalanceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly leaveTypeId: string,
    public readonly year: number,
    public readonly adjustment: number,
    public readonly reason: string,
  ) {}
}
