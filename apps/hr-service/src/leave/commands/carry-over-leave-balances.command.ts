export class CarryOverLeaveBalancesCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly fromYear: number,
    public readonly toYear: number,
  ) {}
}
