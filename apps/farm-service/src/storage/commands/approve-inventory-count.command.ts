export class ApproveInventoryCountCommand {
  constructor(
    public readonly countId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized approver display name from JWT for audit trail */
    public readonly userName?: string,
  ) {}
}
