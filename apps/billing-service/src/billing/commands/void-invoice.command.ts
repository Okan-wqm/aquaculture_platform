export class VoidInvoiceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly reason: string,
    public readonly userId: string,
  ) {}
}
