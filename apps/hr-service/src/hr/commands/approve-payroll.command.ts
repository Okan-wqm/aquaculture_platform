export class ApprovePayrollCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payrollId: string,
    public readonly userId: string,
  ) {}
}
