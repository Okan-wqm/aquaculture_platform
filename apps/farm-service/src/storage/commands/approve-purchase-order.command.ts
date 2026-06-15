export class ApprovePurchaseOrderCommand {
  constructor(
    public readonly purchaseOrderId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized approver display name from JWT for the audit trail. */
    public readonly userName?: string,
  ) {}
}
