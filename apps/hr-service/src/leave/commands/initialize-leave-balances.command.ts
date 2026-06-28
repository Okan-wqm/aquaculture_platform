export class InitializeLeaveBalancesCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly year: number,
  ) {}
}
