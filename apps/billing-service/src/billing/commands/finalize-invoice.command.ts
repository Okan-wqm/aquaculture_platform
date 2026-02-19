export class FinalizeInvoiceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly userId: string,
  ) {}
}
