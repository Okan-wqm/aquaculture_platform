export class RejectLeaveRequestCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly leaveRequestId: string,
    public readonly reason: string,
  ) {}
}
