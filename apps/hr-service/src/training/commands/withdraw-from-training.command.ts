export class WithdrawFromTrainingCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly enrollmentId: string,
    // The caller's own employee id, resolved from the JWT subject in the resolver.
    // Self-service withdraw: the enrollment MUST belong to this employee.
    public readonly callerEmployeeId: string,
    public readonly reason?: string,
  ) {}
}
