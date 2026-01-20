export class SubmitLeaveRequestCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly leaveRequestId: string,
  ) {}
}
