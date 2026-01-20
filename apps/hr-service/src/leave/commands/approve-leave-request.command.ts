export class ApproveLeaveRequestCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly leaveRequestId: string,
    public readonly notes?: string,
  ) {}
}
