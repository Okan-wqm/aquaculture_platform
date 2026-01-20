export class GetLeaveRequestByIdQuery {
  constructor(
    public readonly tenantId: string,
    public readonly leaveRequestId: string,
  ) {}
}
