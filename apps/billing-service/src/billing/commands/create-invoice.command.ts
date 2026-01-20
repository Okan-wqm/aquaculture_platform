import { CreateInvoiceInput } from '../dto/create-invoice.input';

export class CreateInvoiceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateInvoiceInput,
    public readonly userId: string,
  ) {}
}
